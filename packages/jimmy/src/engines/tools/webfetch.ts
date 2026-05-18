/**
 * `webfetch` tool — HTTP/HTTPS fetch with strict network controls.
 *
 * Why not bare `fetch`?
 *   We need to validate the IP address actually used by the socket (DNS
 *   rebinding mitigation). Bare fetch in Node doesn't let you intercept
 *   the connect-time DNS lookup. node:http / node:https `request` accept
 *   a `lookup` option that lets us return only validated addresses.
 *
 * Hardening posture (V1):
 *   - Scheme: http: and https: only. file:, ftp:, gopher:, etc. rejected.
 *   - IP literals in the URL hostname are validated against ipBlocklist.
 *   - For hostnames: dns.resolve4 + dns.resolve6 BEFORE connect. If any
 *     resolved address is on the blocklist, refuse the whole request.
 *   - At connect time, a custom net.LookupFunction runs again as defense
 *     in depth — even if the cached pre-resolved set was clean, the
 *     address handed to the socket gets re-validated. DNS rebinding
 *     attempts hit this gate.
 *   - Redirects: same-scheme only, hard limit of 5, every redirect target
 *     re-validated from scratch.
 *   - Total wall-clock deadline (default 15s) covers the whole call,
 *     including all redirects.
 *   - Response body capped at 2 MB raw; the socket is destroyed once
 *     the cap is exceeded (we do NOT buffer the whole response and then
 *     truncate).
 *   - Content-Type whitelist: text/* and a small set of application/*
 *     (json, xml, atom, rss, yaml). Other types → non_text_content.
 *   - Caller can opt into private-network destinations with
 *     toolOpts.webfetch.allowPrivate = true. Default false.
 *   - Never throws to caller. All failure modes return {ok:false, audit:
 *     {error: <reason code>, ...}}.
 */

import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import { URL } from "node:url";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import type { JsonObject, JsonValue } from "../../shared/types.js";
import {
  checkAddress,
  checkIPv4,
  checkIPv6,
  parseIpLiteral,
} from "./ipBlocklist.js";
import type { ToolExecutionContext, ToolResult } from "./types.js";

const DEFAULT_MAX_CHARS = 64_000;
const DEFAULT_MAX_RAW_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

const ALLOWED_CONTENT_TYPES = [
  "text/",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/atom+xml",
  "application/rss+xml",
  "application/yaml",
  "application/x-yaml",
  "application/ld+json",
];

interface WebfetchOpts {
  maxChars: number;
  maxRawBytes: number;
  perCallTimeoutMs: number;
  allowPrivate: boolean;
}

function readOpts(ctx: ToolExecutionContext): WebfetchOpts {
  const raw = (ctx.toolOpts?.webfetch ?? {}) as Record<string, JsonValue | undefined>;
  return {
    maxChars: typeof raw.maxChars === "number" ? raw.maxChars : DEFAULT_MAX_CHARS,
    maxRawBytes: typeof raw.maxRawBytes === "number" ? raw.maxRawBytes : DEFAULT_MAX_RAW_BYTES,
    perCallTimeoutMs:
      typeof raw.perCallTimeoutMs === "number" ? raw.perCallTimeoutMs : DEFAULT_TIMEOUT_MS,
    allowPrivate: raw.allowPrivate === true,
  };
}

interface WebfetchArgs {
  url: string;
}

function parseArgs(raw: JsonObject): { ok: true; args: WebfetchArgs } | { ok: false; reason: string } {
  if (typeof raw.url !== "string" || raw.url.length === 0) {
    return { ok: false, reason: "webfetch: 'url' is required and must be a non-empty string" };
  }
  return { ok: true, args: { url: raw.url } };
}

function contentTypeAllowed(headerValue: string | undefined): boolean {
  if (!headerValue) return false;
  const main = headerValue.split(";")[0]!.trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.some((p) => main === p || main.startsWith(p));
}

/**
 * Validate a hostname by resolving via dns.lookup({all:true}) and checking
 * every returned address. We use lookup() not resolve4/6 because:
 *   - lookup() consults /etc/hosts and the OS resolver, matching what the
 *     socket-time custom LookupFunction will see. resolve4/6 are
 *     DNS-protocol-only and miss /etc/hosts entries (e.g. localhost).
 *   - Returns both A and AAAA in one call.
 */
async function preResolve(
  host: string,
  allowPrivate: boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const literal = parseIpLiteral(host);
  if (literal) {
    if (allowPrivate) return { ok: true };
    const r = checkAddress(literal.family, literal.address);
    return r ? { ok: false, reason: r } : { ok: true };
  }
  let all: LookupAddress[];
  try {
    all = await dns.lookup(host, { all: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "dns_error";
    return {
      ok: false,
      reason: code === "ENOTFOUND" || code === "ENODATA" ? "dns_no_addresses" : code,
    };
  }
  if (all.length === 0) {
    return { ok: false, reason: "dns_no_addresses" };
  }
  if (allowPrivate) return { ok: true };
  for (const a of all) {
    const r = a.family === 4 ? checkIPv4(a.address) : checkIPv6(a.address);
    if (r) return { ok: false, reason: r };
  }
  return { ok: true };
}

/**
 * Construct a net.LookupFunction that validates the resolved address before
 * the socket connects. This is the DNS-rebinding mitigation — even if the
 * pre-resolve check passed against a clean address set, the actual address
 * handed to the socket is verified here.
 *
 * Exported so unit tests can exercise the validator path directly without
 * setting up real sockets.
 */
export function buildLookup(allowPrivate: boolean): LookupFunction {
  // Cast through `as` because node:net's LookupFunction signature uses an
  // overloaded shape that's awkward to type from TS strictly.
  return ((hostname: string, optsOrCallback: unknown, maybeCallback?: unknown): void => {
    const callback = (typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback) as (
      err: NodeJS.ErrnoException | null,
      address?: string,
      family?: number,
    ) => void;
    const options = (typeof optsOrCallback === "object" && optsOrCallback !== null ? optsOrCallback : {}) as LookupOptions;
    dns
      .lookup(hostname, options)
      .then((result) => {
        const single = result as LookupAddress;
        if (!allowPrivate) {
          const reason = checkAddress(single.family, single.address);
          if (reason) {
            const err: NodeJS.ErrnoException = Object.assign(new Error(reason), { code: reason });
            callback(err);
            return;
          }
        }
        callback(null, single.address, single.family);
      })
      .catch((err) => callback(err as NodeJS.ErrnoException));
  }) as unknown as LookupFunction;
}

interface FetchedOnce {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  bodyTruncated: boolean;
  originalBytes: number;
  redirectTo: string | null;
}

interface FetchOnceFail {
  failure: string;
  detail?: string;
}

async function fetchOnce(
  rawUrl: string,
  opts: WebfetchOpts,
  deadline: number,
  lookup: LookupFunction,
): Promise<{ ok: true; res: FetchedOnce } | { ok: false; fail: FetchOnceFail }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, fail: { failure: "bad_url", detail: rawUrl } };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, fail: { failure: "disallowed_scheme", detail: url.protocol } };
  }

  const pre = await preResolve(url.hostname, opts.allowPrivate);
  if (!pre.ok) return { ok: false, fail: { failure: pre.reason } };

  const remaining = deadline - Date.now();
  if (remaining <= 0) return { ok: false, fail: { failure: "timeout" } };

  const transport = url.protocol === "https:" ? https : http;

  return await new Promise((resolve) => {
    let settled = false;
    let aborted = false;
    let receivedBytes = 0;
    const chunks: Buffer[] = [];

    const settle = (out: { ok: true; res: FetchedOnce } | { ok: false; fail: FetchOnceFail }) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (jin-webfetch/0.1)",
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
        },
        lookup,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers = res.headers;

        // Redirect: capture Location, drain (briefly) and resolve.
        // HTTP spec says Location is single-valued, but node's
        // IncomingHttpHeaders types it as `string | string[]`. Defensively
        // unwrap so an unusual server can't poison the URL with comma-joins.
        const locRaw = headers.location;
        const locStr = Array.isArray(locRaw) ? locRaw[0] : locRaw;
        if (status >= 300 && status < 400 && locStr) {
          // Don't accumulate body bytes for redirect responses.
          res.resume();
          res.on("end", () => {
            settle({
              ok: true,
              res: {
                status,
                headers,
                body: "",
                bodyTruncated: false,
                originalBytes: 0,
                redirectTo: locStr,
              },
            });
          });
          res.on("error", () => {
            settle({
              ok: true,
              res: {
                status,
                headers,
                body: "",
                bodyTruncated: false,
                originalBytes: 0,
                redirectTo: locStr,
              },
            });
          });
          return;
        }

        // Non-redirect: check content-type before streaming.
        const ct = headers["content-type"];
        if (!contentTypeAllowed(typeof ct === "string" ? ct : undefined)) {
          req.destroy();
          settle({
            ok: false,
            fail: { failure: "non_text_content", detail: typeof ct === "string" ? ct : "missing" },
          });
          return;
        }

        res.on("data", (chunk: Buffer) => {
          if (aborted) return;
          receivedBytes += chunk.length;
          if (receivedBytes > opts.maxRawBytes) {
            aborted = true;
            const overshoot = receivedBytes - opts.maxRawBytes;
            const usable = chunk.length - overshoot;
            if (usable > 0) chunks.push(chunk.subarray(0, usable));
            req.destroy();
            settle({
              ok: true,
              res: {
                status,
                headers,
                body: Buffer.concat(chunks).toString("utf8"),
                bodyTruncated: true,
                originalBytes: receivedBytes,
                redirectTo: null,
              },
            });
          } else {
            chunks.push(chunk);
          }
        });
        res.on("end", () => {
          if (aborted) return;
          settle({
            ok: true,
            res: {
              status,
              headers,
              body: Buffer.concat(chunks).toString("utf8"),
              bodyTruncated: false,
              originalBytes: receivedBytes,
              redirectTo: null,
            },
          });
        });
        res.on("error", (err) => {
          if (settled) return;
          settle({ ok: false, fail: { failure: "stream_error", detail: err.message } });
        });
      },
    );

    req.on("error", (err) => {
      // Custom-lookup errors flow through here as well.
      const code = (err as NodeJS.ErrnoException).code ?? "request_error";
      settle({ ok: false, fail: { failure: code, detail: err.message } });
    });

    // Wall-clock deadline (covers DNS + connect + TLS + body).
    const timer = setTimeout(() => {
      aborted = true;
      try {
        req.destroy();
      } catch {
        // ignore
      }
      settle({ ok: false, fail: { failure: "timeout" } });
    }, remaining);
    req.on("close", () => clearTimeout(timer));

    req.end();
  });
}

function modelTruncate(body: string, maxChars: number, totalBytes: number, alreadyTruncated: boolean): {
  text: string;
  truncated: boolean;
} {
  if (body.length <= maxChars && !alreadyTruncated) {
    return { text: body, truncated: false };
  }
  if (body.length <= maxChars && alreadyTruncated) {
    return {
      text: body + `\n[truncated: server returned > ${totalBytes} bytes; raw cap hit]`,
      truncated: true,
    };
  }
  return {
    text:
      body.slice(0, maxChars) +
      `\n[truncated: ${maxChars} of ${body.length} characters returned to model${alreadyTruncated ? `; underlying body capped at ${totalBytes} bytes` : ""}]`,
    truncated: true,
  };
}

export async function webfetchTool(raw: JsonObject, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = parseArgs(raw);
  if (!parsed.ok) {
    return { ok: false, content: parsed.reason, audit: { truncated: false, error: "bad_args" } };
  }
  const opts = readOpts(ctx);
  const lookup = buildLookup(opts.allowPrivate);
  const deadline = Date.now() + opts.perCallTimeoutMs;

  let currentUrl = parsed.args.url;
  const redirectChain: string[] = [currentUrl];
  let currentScheme = "";

  try {
    currentScheme = new URL(currentUrl).protocol;
  } catch {
    return { ok: false, content: `webfetch: bad URL "${currentUrl}"`, audit: { truncated: false, error: "bad_url" } };
  }
  if (currentScheme !== "http:" && currentScheme !== "https:") {
    return {
      ok: false,
      content: `webfetch: scheme "${currentScheme}" not allowed (http/https only)`,
      audit: { truncated: false, error: "disallowed_scheme", scheme: currentScheme },
    };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (Date.now() >= deadline) {
      return {
        ok: false,
        content: `webfetch: total timeout after ${opts.perCallTimeoutMs}ms`,
        audit: {
          truncated: false,
          error: "timeout",
          redirect_chain: redirectChain,
          hops: hop,
        },
      };
    }
    const single = await fetchOnce(currentUrl, opts, deadline, lookup);
    if (!single.ok) {
      return {
        ok: false,
        content: `webfetch: ${single.fail.failure}${single.fail.detail ? ` — ${single.fail.detail}` : ""}`,
        audit: {
          truncated: false,
          error: single.fail.failure,
          redirect_chain: redirectChain,
          hops: hop,
        },
      };
    }
    const r = single.res;
    if (r.redirectTo !== null) {
      // Resolve relative redirects against the current URL.
      let nextUrl: URL;
      try {
        nextUrl = new URL(r.redirectTo, currentUrl);
      } catch {
        return {
          ok: false,
          content: `webfetch: bad redirect Location "${r.redirectTo}"`,
          audit: { truncated: false, error: "bad_redirect", redirect_chain: redirectChain, hops: hop },
        };
      }
      if (nextUrl.protocol !== currentScheme) {
        return {
          ok: false,
          content: `webfetch: redirect changes scheme (${currentScheme} → ${nextUrl.protocol}); same-scheme redirects only`,
          audit: {
            truncated: false,
            error: "scheme_change_redirect",
            redirect_chain: [...redirectChain, nextUrl.toString()],
            hops: hop,
          },
        };
      }
      if (hop >= MAX_REDIRECTS) {
        return {
          ok: false,
          content: `webfetch: redirect limit (${MAX_REDIRECTS}) exhausted`,
          audit: {
            truncated: false,
            error: "redirect_limit",
            redirect_chain: [...redirectChain, nextUrl.toString()],
            hops: hop + 1,
          },
        };
      }
      currentUrl = nextUrl.toString();
      redirectChain.push(currentUrl);
      continue;
    }

    // Terminal response.
    const { text, truncated } = modelTruncate(r.body, opts.maxChars, r.originalBytes, r.bodyTruncated);
    const ok = r.status >= 200 && r.status < 300;
    const ctHeader = r.headers["content-type"];
    return {
      ok,
      content: text,
      audit: {
        truncated,
        original_bytes: r.originalBytes,
        http_status: r.status,
        content_type: typeof ctHeader === "string" ? ctHeader : null,
        redirect_chain: redirectChain,
        hops: hop,
        error: ok ? undefined : "http_status",
      },
    };
  }

  return {
    ok: false,
    content: `webfetch: redirect limit (${MAX_REDIRECTS}) exhausted`,
    audit: { truncated: false, error: "redirect_limit", redirect_chain: redirectChain, hops: MAX_REDIRECTS },
  };
}
