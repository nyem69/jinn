/**
 * IP-address blocklist for the webfetch tool.
 *
 * Pure functions, no I/O — exported so the agent loop, tests, and the
 * webfetch tool itself can share one canonical "is this address safe to
 * connect to" decision. Reason codes flow through to ToolResult.audit.error.
 */

import net from "node:net";

export type BlockReason =
  | "blocked_unspecified"
  | "blocked_loopback"
  | "blocked_private"
  | "blocked_cgnat"
  | "blocked_link_local"
  | "blocked_unique_local"
  | "blocked_multicast"
  | "blocked_broadcast";

interface IPv4Range {
  base: number;
  mask: number;
  reason: BlockReason;
}

function ipv4ToInt(addr: string): number {
  const parts = addr.split(".");
  if (parts.length !== 4) return NaN;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return NaN;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

const IPV4_RANGES: IPv4Range[] = [
  { base: 0x00000000, mask: 0xff000000, reason: "blocked_unspecified" }, // 0.0.0.0/8
  { base: 0x0a000000, mask: 0xff000000, reason: "blocked_private" }, // 10.0.0.0/8
  { base: 0x64400000, mask: 0xffc00000, reason: "blocked_cgnat" }, // 100.64.0.0/10
  { base: 0x7f000000, mask: 0xff000000, reason: "blocked_loopback" }, // 127.0.0.0/8
  { base: 0xa9fe0000, mask: 0xffff0000, reason: "blocked_link_local" }, // 169.254.0.0/16
  { base: 0xac100000, mask: 0xfff00000, reason: "blocked_private" }, // 172.16.0.0/12
  { base: 0xc0a80000, mask: 0xffff0000, reason: "blocked_private" }, // 192.168.0.0/16
  { base: 0xe0000000, mask: 0xf0000000, reason: "blocked_multicast" }, // 224.0.0.0/4
  { base: 0xffffffff, mask: 0xffffffff, reason: "blocked_broadcast" }, // 255.255.255.255/32
];

export function checkIPv4(addr: string): BlockReason | null {
  if (!net.isIPv4(addr)) return null;
  const n = ipv4ToInt(addr);
  if (Number.isNaN(n)) return null;
  for (const r of IPV4_RANGES) {
    // `>>> 0` re-unsigns the AND result — JS bitwise ops produce signed
    // int32, and ranges like 0xff000000 round-trip as negative without this.
    if (((n & r.mask) >>> 0) === r.base) return r.reason;
  }
  return null;
}

/**
 * Expand an IPv6 address (which may include "::" compression) into its 8
 * 16-bit hextet integers. Returns null if the address is not parseable.
 */
function parseIPv6(addr: string): number[] | null {
  if (!net.isIPv6(addr)) return null;

  // Strip a possible zone-id (e.g. "fe80::1%eth0"); the canonical address is
  // everything before "%".
  const at = addr.indexOf("%");
  const naked = at === -1 ? addr : addr.slice(0, at);

  // Handle IPv4-embedded suffix (e.g. ::ffff:1.2.3.4) — convert that v4
  // portion into two hextets.
  const lastColon = naked.lastIndexOf(":");
  let head = naked;
  let tail4: number[] | null = null;
  if (lastColon !== -1) {
    const maybeV4 = naked.slice(lastColon + 1);
    if (net.isIPv4(maybeV4)) {
      const n = ipv4ToInt(maybeV4);
      if (!Number.isNaN(n)) {
        tail4 = [(n >>> 16) & 0xffff, n & 0xffff];
        head = naked.slice(0, lastColon);
      }
    }
  }

  const hextets: number[] = [];
  const doubleColon = head.indexOf("::");
  if (doubleColon === -1) {
    const segs = head.split(":");
    for (const s of segs) hextets.push(parseInt(s, 16) | 0);
  } else {
    const left = head.slice(0, doubleColon);
    const right = head.slice(doubleColon + 2);
    const leftSegs = left === "" ? [] : left.split(":");
    const rightSegs = right === "" ? [] : right.split(":");
    const totalNeeded = (tail4 ? 6 : 8) - leftSegs.length - rightSegs.length;
    for (const s of leftSegs) hextets.push(parseInt(s, 16) | 0);
    for (let i = 0; i < totalNeeded; i++) hextets.push(0);
    for (const s of rightSegs) hextets.push(parseInt(s, 16) | 0);
  }
  if (tail4) hextets.push(...tail4);
  if (hextets.length !== 8) return null;
  for (const h of hextets) {
    if (h < 0 || h > 0xffff || Number.isNaN(h)) return null;
  }
  return hextets;
}

export function checkIPv6(addr: string): BlockReason | null {
  const hextets = parseIPv6(addr);
  if (!hextets) return null;
  const allZero = hextets.every((h) => h === 0);
  if (allZero) return "blocked_unspecified"; // ::
  if (
    hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 &&
    hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0 &&
    hextets[6] === 0 && hextets[7] === 1
  ) {
    return "blocked_loopback"; // ::1
  }

  // ::ffff:0:0/96 — IPv4-mapped IPv6. Validate the embedded v4.
  if (
    hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 &&
    hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0xffff
  ) {
    const v4 = `${(hextets[6]! >>> 8) & 0xff}.${hextets[6]! & 0xff}.${(hextets[7]! >>> 8) & 0xff}.${hextets[7]! & 0xff}`;
    const reason = checkIPv4(v4);
    if (reason) return reason;
    return null;
  }

  // fe80::/10 — first 10 bits = 1111111010
  if ((hextets[0]! & 0xffc0) === 0xfe80) return "blocked_link_local";
  // fc00::/7 — first 7 bits = 1111110
  if ((hextets[0]! & 0xfe00) === 0xfc00) return "blocked_unique_local";
  // ff00::/8
  if ((hextets[0]! & 0xff00) === 0xff00) return "blocked_multicast";

  return null;
}

/** Convenience: dispatch by family. */
export function checkAddress(family: number, addr: string): BlockReason | null {
  if (family === 4) return checkIPv4(addr);
  if (family === 6) return checkIPv6(addr);
  return null;
}

/**
 * Return the (family, address) tuple if `host` is an IP literal — including
 * bracketed IPv6 notation as seen in URLs. Returns null for hostnames.
 */
export function parseIpLiteral(host: string): { family: 4 | 6; address: string } | null {
  if (!host || typeof host !== "string") return null;
  if (net.isIPv4(host)) return { family: 4, address: host };
  let bare = host;
  if (host.startsWith("[") && host.endsWith("]")) {
    bare = host.slice(1, -1);
  }
  if (net.isIPv6(bare)) return { family: 6, address: bare };
  return null;
}
