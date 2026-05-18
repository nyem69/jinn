import { describe, it, expect } from "vitest";
import { checkIPv4, checkIPv6, parseIpLiteral } from "../ipBlocklist.js";

describe("ipBlocklist — IPv4", () => {
  it("returns null for routable public addresses", () => {
    expect(checkIPv4("1.1.1.1")).toBeNull();
    expect(checkIPv4("8.8.8.8")).toBeNull();
    expect(checkIPv4("142.250.190.78")).toBeNull(); // google
  });

  it("blocks 0.0.0.0/8 as unspecified", () => {
    expect(checkIPv4("0.0.0.0")).toBe("blocked_unspecified");
    expect(checkIPv4("0.1.2.3")).toBe("blocked_unspecified");
  });

  it("blocks loopback 127.0.0.0/8", () => {
    expect(checkIPv4("127.0.0.1")).toBe("blocked_loopback");
    expect(checkIPv4("127.255.255.255")).toBe("blocked_loopback");
  });

  it("blocks RFC1918 ranges", () => {
    expect(checkIPv4("10.0.0.1")).toBe("blocked_private");
    expect(checkIPv4("10.255.255.255")).toBe("blocked_private");
    expect(checkIPv4("172.16.0.1")).toBe("blocked_private");
    expect(checkIPv4("172.31.255.255")).toBe("blocked_private");
    expect(checkIPv4("172.15.0.1")).toBeNull(); // just outside
    expect(checkIPv4("172.32.0.1")).toBeNull();
    expect(checkIPv4("192.168.0.1")).toBe("blocked_private");
    expect(checkIPv4("192.168.255.255")).toBe("blocked_private");
  });

  it("blocks CGNAT 100.64.0.0/10", () => {
    expect(checkIPv4("100.64.0.1")).toBe("blocked_cgnat");
    expect(checkIPv4("100.127.255.255")).toBe("blocked_cgnat");
    expect(checkIPv4("100.63.255.255")).toBeNull(); // just outside
    expect(checkIPv4("100.128.0.1")).toBeNull();
  });

  it("blocks link-local 169.254.0.0/16", () => {
    expect(checkIPv4("169.254.1.1")).toBe("blocked_link_local");
    expect(checkIPv4("169.254.255.255")).toBe("blocked_link_local");
    expect(checkIPv4("169.253.255.255")).toBeNull();
  });

  it("blocks multicast 224.0.0.0/4", () => {
    expect(checkIPv4("224.0.0.1")).toBe("blocked_multicast");
    expect(checkIPv4("239.255.255.255")).toBe("blocked_multicast");
    expect(checkIPv4("223.255.255.255")).toBeNull();
  });

  it("blocks broadcast 255.255.255.255", () => {
    expect(checkIPv4("255.255.255.255")).toBe("blocked_broadcast");
  });

  it("returns null for non-IPv4 input", () => {
    expect(checkIPv4("not-an-ip")).toBeNull();
    expect(checkIPv4("::1")).toBeNull(); // IPv6 not handled here
  });
});

describe("ipBlocklist — IPv6", () => {
  it("returns null for routable public addresses", () => {
    expect(checkIPv6("2001:4860:4860::8888")).toBeNull(); // google
    expect(checkIPv6("2606:4700:4700::1111")).toBeNull(); // cloudflare
  });

  it("blocks :: (unspecified)", () => {
    expect(checkIPv6("::")).toBe("blocked_unspecified");
  });

  it("blocks ::1 (loopback)", () => {
    expect(checkIPv6("::1")).toBe("blocked_loopback");
  });

  it("blocks fc00::/7 (unique local)", () => {
    expect(checkIPv6("fc00::1")).toBe("blocked_unique_local");
    expect(checkIPv6("fd12:3456:789a:bcde::1")).toBe("blocked_unique_local");
    expect(checkIPv6("fdff::1")).toBe("blocked_unique_local");
  });

  it("blocks fe80::/10 (link-local)", () => {
    expect(checkIPv6("fe80::1")).toBe("blocked_link_local");
    expect(checkIPv6("febf::1")).toBe("blocked_link_local");
    expect(checkIPv6("fec0::1")).toBeNull(); // just outside fe80::/10 (fec0/10 is site-local, deprecated; not blocked here)
  });

  it("blocks ff00::/8 (multicast)", () => {
    expect(checkIPv6("ff02::1")).toBe("blocked_multicast");
    expect(checkIPv6("ff05::1:3")).toBe("blocked_multicast");
  });

  it("blocks IPv4-mapped IPv6 addresses by their embedded v4", () => {
    expect(checkIPv6("::ffff:127.0.0.1")).toBe("blocked_loopback");
    expect(checkIPv6("::ffff:10.0.0.1")).toBe("blocked_private");
    expect(checkIPv6("::ffff:169.254.1.1")).toBe("blocked_link_local");
    expect(checkIPv6("::ffff:8.8.8.8")).toBeNull();
  });

  it("handles zone-id suffix in fe80::%iface form", () => {
    expect(checkIPv6("fe80::1%eth0")).toBe("blocked_link_local");
  });

  it("returns null for non-IPv6 input", () => {
    expect(checkIPv6("not-an-ip")).toBeNull();
    expect(checkIPv6("127.0.0.1")).toBeNull();
  });
});

describe("ipBlocklist — parseIpLiteral", () => {
  it("recognizes bare IPv4", () => {
    expect(parseIpLiteral("127.0.0.1")).toEqual({ family: 4, address: "127.0.0.1" });
  });

  it("recognizes bracketed IPv6 (URL style)", () => {
    expect(parseIpLiteral("[::1]")).toEqual({ family: 6, address: "::1" });
    expect(parseIpLiteral("[2001:db8::1]")).toEqual({ family: 6, address: "2001:db8::1" });
  });

  it("recognizes unbracketed IPv6", () => {
    expect(parseIpLiteral("::1")).toEqual({ family: 6, address: "::1" });
  });

  it("returns null for hostnames", () => {
    expect(parseIpLiteral("example.com")).toBeNull();
    expect(parseIpLiteral("localhost")).toBeNull(); // is a hostname, not a literal
  });

  it("returns null for empty/invalid input", () => {
    expect(parseIpLiteral("")).toBeNull();
    expect(parseIpLiteral("not.an.ip")).toBeNull();
  });
});
