/**
 * Direct unit coverage for buildLookup — the function passed to
 * http.request({lookup}). The integration test in webfetch.test.ts proves
 * the chain end-to-end via fixture server requests, but this file exercises
 * the validator path on its own so a regression in the address-check
 * surfaces immediately, independent of HTTP server state.
 *
 * Note on the broader DNS-rebinding guarantee:
 * Node's documented contract for http.request's `lookup` option is that the
 * function returned here IS invoked at socket-connect time, and the address
 * it passes back IS what the socket dials. We rely on that contract;
 * exercising it under a stub is not feasible without monkey-patching
 * internal node:http machinery.
 */
import { describe, it, expect } from "vitest";
import { buildLookup } from "../webfetch.js";

function callLookup(
  fn: ReturnType<typeof buildLookup>,
  hostname: string,
): Promise<{ err: NodeJS.ErrnoException | null; address?: string; family?: number }> {
  return new Promise((resolve) => {
    // node:net's LookupFunction has an overloaded signature; we invoke the
    // 3-arg form (hostname, options, callback) the http module uses.
    (fn as unknown as (
      h: string,
      opts: object,
      cb: (err: NodeJS.ErrnoException | null, address?: string, family?: number) => void,
    ) => void)(hostname, {}, (err, address, family) => {
      resolve({ err, address, family });
    });
  });
}

describe("buildLookup (strict: allowPrivate=false)", () => {
  const lookup = buildLookup(false);

  it("rejects localhost because it resolves to a loopback address", async () => {
    const r = await callLookup(lookup, "localhost");
    expect(r.err).toBeTruthy();
    expect(r.err!.code).toMatch(/blocked_loopback/);
  });

  it("returns an address for a routable public hostname", async () => {
    // 1.1.1.1.nip.io is a public DNS service that maps hostnames of the
    // form a.b.c.d.nip.io → a.b.c.d. It's stable enough to use as a
    // public-resolution probe. If the test environment has no network,
    // this test will skip (we tolerate ENOTFOUND).
    const r = await callLookup(lookup, "one.one.one.one");
    if (r.err && (r.err.code === "ENOTFOUND" || r.err.code === "EAI_AGAIN")) {
      return; // offline test env — skip
    }
    expect(r.err).toBeNull();
    expect(r.address).toBeTruthy();
    expect(r.family === 4 || r.family === 6).toBe(true);
  }, 10_000);

  it("rejects an IPv4 literal hostname when it resolves to a private address", async () => {
    // dns.lookup of an IPv4 literal returns that literal immediately,
    // exercising our validator on the connect-time address.
    const r = await callLookup(lookup, "10.0.0.1");
    expect(r.err).toBeTruthy();
    expect(r.err!.code).toMatch(/blocked_private/);
  });

  it("rejects [::1] equivalent hostname", async () => {
    const r = await callLookup(lookup, "::1");
    expect(r.err).toBeTruthy();
    expect(r.err!.code).toMatch(/blocked_loopback/);
  });

  it("rejects 169.254.169.254 (AWS metadata endpoint)", async () => {
    const r = await callLookup(lookup, "169.254.169.254");
    expect(r.err).toBeTruthy();
    expect(r.err!.code).toMatch(/blocked_link_local/);
  });
});

describe("buildLookup (permissive: allowPrivate=true)", () => {
  const lookup = buildLookup(true);

  it("accepts localhost when allowPrivate=true", async () => {
    const r = await callLookup(lookup, "localhost");
    expect(r.err).toBeNull();
    expect(r.address).toBeTruthy();
  });

  it("accepts 10.0.0.1 literal when allowPrivate=true", async () => {
    const r = await callLookup(lookup, "10.0.0.1");
    expect(r.err).toBeNull();
    expect(r.address).toBe("10.0.0.1");
  });
});
