import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { webfetchTool } from "../webfetch.js";
import type { ToolExecutionContext } from "../types.js";
import type { JsonObject, JsonValue } from "../../../shared/types.js";

// ─── Fixture HTTP server ─────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    const route = url.pathname;

    if (route === "/text") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("hello, fixture\n");
      return;
    }
    if (route === "/json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, n: 42 }));
      return;
    }
    if (route === "/html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>fix</h1></body></html>");
      return;
    }
    if (route === "/binary") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.from([0, 1, 2, 3, 4, 5]));
      return;
    }
    if (route === "/big") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      // Send 3 MB in 64k chunks — should overflow the 2 MB raw cap.
      let sent = 0;
      const chunk = Buffer.alloc(64 * 1024, 0x78); // 'x'
      const tick = () => {
        if (sent >= 3 * 1024 * 1024) {
          res.end();
          return;
        }
        sent += chunk.length;
        if (res.write(chunk)) {
          setImmediate(tick);
        } else {
          res.once("drain", tick);
        }
      };
      tick();
      return;
    }
    if (route === "/slow") {
      // Send headers, then hang.
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("starting...\n");
      // Don't end; just hold. The deadline in the tool should fire.
      return;
    }
    if (route === "/redirect-once") {
      res.writeHead(302, { Location: "/text" });
      res.end();
      return;
    }
    if (route === "/redirect-loop") {
      // Each hop bumps a counter; loops indefinitely.
      const n = parseInt(url.searchParams.get("n") ?? "0", 10) || 0;
      res.writeHead(302, { Location: `/redirect-loop?n=${n + 1}` });
      res.end();
      return;
    }
    if (route === "/redirect-to-private") {
      // Send the model to 10.0.0.1 — should be blocked even though our
      // fixture itself is on loopback.
      res.writeHead(302, { Location: "http://10.0.0.1/" });
      res.end();
      return;
    }
    if (route === "/redirect-to-https") {
      res.writeHead(302, { Location: "https://example.com/" });
      res.end();
      return;
    }
    if (route === "/redirect-to-file") {
      res.writeHead(302, { Location: "file:///etc/passwd" });
      res.end();
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  port = addr.port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function ctxAllow(extra: Record<string, JsonValue> = {}): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    toolOpts: { webfetch: { allowPrivate: true, ...extra } as JsonObject },
  };
}
function ctxStrict(extra: Record<string, JsonValue> = {}): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    toolOpts: { webfetch: { allowPrivate: false, ...extra } as JsonObject },
  };
}

// ─── Happy path (allowPrivate so we can hit the local fixture) ───────

describe("webfetch — happy path", () => {
  it("fetches a small text response", async () => {
    const r = await webfetchTool({ url: `${baseUrl}/text` }, ctxAllow());
    expect(r.ok).toBe(true);
    expect(r.content).toContain("hello, fixture");
    expect(r.audit.http_status).toBe(200);
    expect(r.audit.truncated).toBe(false);
    expect(r.audit.hops).toBe(0);
  });

  it("fetches JSON", async () => {
    const r = await webfetchTool({ url: `${baseUrl}/json` }, ctxAllow());
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content).n).toBe(42);
    expect(r.audit.content_type).toMatch(/json/);
  });

  it("fetches HTML", async () => {
    const r = await webfetchTool({ url: `${baseUrl}/html` }, ctxAllow());
    expect(r.ok).toBe(true);
    expect(r.content).toContain("<h1>fix</h1>");
  });
});

// ─── Scheme + content-type gates ─────────────────────────────────────

describe("webfetch — scheme rejection", () => {
  it("rejects file://", async () => {
    const r = await webfetchTool({ url: "file:///etc/passwd" }, ctxAllow());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("disallowed_scheme");
  });

  it("rejects ftp://", async () => {
    const r = await webfetchTool({ url: "ftp://example.com/" }, ctxAllow());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("disallowed_scheme");
  });

  it("rejects gopher://", async () => {
    const r = await webfetchTool({ url: "gopher://example.com/" }, ctxAllow());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("disallowed_scheme");
  });
});

describe("webfetch — content-type gating", () => {
  it("rejects application/octet-stream", async () => {
    const r = await webfetchTool({ url: `${baseUrl}/binary` }, ctxAllow());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("non_text_content");
  });
});

// ─── Network controls (private/IP blocks) ────────────────────────────

describe("webfetch — IP literal / DNS blocks (allowPrivate=false default)", () => {
  it("blocks http://127.0.0.1/", async () => {
    const r = await webfetchTool({ url: `http://127.0.0.1:${port}/text` }, ctxStrict());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("blocked_loopback");
  });

  it("blocks http://localhost/ via DNS pre-resolve", async () => {
    const r = await webfetchTool({ url: `http://localhost:${port}/text` }, ctxStrict());
    expect(r.ok).toBe(false);
    // localhost may resolve to 127.0.0.1 (loopback) or ::1 (also loopback).
    expect(r.audit.error).toBe("blocked_loopback");
  });

  it("blocks http://10.0.0.1/ (RFC1918)", async () => {
    const r = await webfetchTool({ url: "http://10.0.0.1/" }, ctxStrict());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("blocked_private");
  });

  it("blocks http://192.168.1.1/", async () => {
    const r = await webfetchTool({ url: "http://192.168.1.1/" }, ctxStrict());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("blocked_private");
  });

  it("blocks http://169.254.169.254/ (link-local, AWS metadata endpoint)", async () => {
    const r = await webfetchTool({ url: "http://169.254.169.254/latest/meta-data/" }, ctxStrict());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("blocked_link_local");
  });

  it("blocks http://100.64.0.1/ (CGNAT)", async () => {
    const r = await webfetchTool({ url: "http://100.64.0.1/" }, ctxStrict());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("blocked_cgnat");
  });

  it("blocks http://[::1]/", async () => {
    const r = await webfetchTool({ url: `http://[::1]:${port}/text` }, ctxStrict());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("blocked_loopback");
  });

  it("blocks http://[fe80::1]/", async () => {
    const r = await webfetchTool({ url: "http://[fe80::1]/" }, ctxStrict());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("blocked_link_local");
  });

  it("blocks an IPv4-mapped IPv6 loopback", async () => {
    const r = await webfetchTool({ url: "http://[::ffff:127.0.0.1]/" }, ctxStrict());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("blocked_loopback");
  });
});

// ─── Redirects ───────────────────────────────────────────────────────

describe("webfetch — redirects", () => {
  it("follows a single safe redirect within allowPrivate scope", async () => {
    const r = await webfetchTool({ url: `${baseUrl}/redirect-once` }, ctxAllow());
    expect(r.ok).toBe(true);
    expect(r.content).toContain("hello, fixture");
    expect(r.audit.hops).toBe(1);
    const chain = r.audit.redirect_chain as string[];
    expect(chain).toHaveLength(2);
  });

  it("captures both URLs in the redirect chain when redirecting to a private target", async () => {
    // With allowPrivate=true throughout, the next-hop pre-resolve passes
    // (10.0.0.1 is a literal IP) but the actual TCP dial either fails
    // fast or hits the timeout. We just verify the chain captured both
    // URLs and the audit error is a connection/timeout-class code
    // (not silently absorbed).
    const r = await webfetchTool(
      { url: `${baseUrl}/redirect-to-private` },
      ctxAllow({ perCallTimeoutMs: 400 }),
    );
    expect(r.ok).toBe(false);
    const chain = r.audit.redirect_chain as string[];
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain[1]).toMatch(/10\.0\.0\.1/);
    expect(
      ["timeout", "EHOSTUNREACH", "ENETUNREACH", "ECONNREFUSED", "EADDRNOTAVAIL", "ETIMEDOUT"],
    ).toContain(r.audit.error);
  }, 3_000);

  it("refuses a redirect that changes scheme (http → https)", async () => {
    const r = await webfetchTool({ url: `${baseUrl}/redirect-to-https` }, ctxAllow());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("scheme_change_redirect");
  });

  it("refuses a redirect to a disallowed scheme (file://)", async () => {
    const r = await webfetchTool({ url: `${baseUrl}/redirect-to-file` }, ctxAllow());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("scheme_change_redirect");
  });

  it("exhausts the redirect limit at 5 with a loop", async () => {
    const r = await webfetchTool({ url: `${baseUrl}/redirect-loop` }, ctxAllow());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("redirect_limit");
    expect(r.audit.hops).toBe(6); // we attempted one beyond the limit
  });
});

// ─── Byte cap stops reading (no full-body buffering) ─────────────────

describe("webfetch — byte cap aborts the request", () => {
  it("caps the body at maxRawBytes, audit.truncated=true", async () => {
    const r = await webfetchTool(
      { url: `${baseUrl}/big` },
      ctxAllow({ maxRawBytes: 256 * 1024, maxChars: 64_000 }),
    );
    expect(r.ok).toBe(true);
    expect(r.audit.truncated).toBe(true);
    expect(r.audit.original_bytes as number).toBeGreaterThanOrEqual(256 * 1024);
    // model-output truncation also kicks in
    expect(r.content.length).toBeLessThan(70_000);
    expect(r.content).toMatch(/truncated/);
  });
});

// ─── Total timeout ───────────────────────────────────────────────────

describe("webfetch — total timeout", () => {
  it("aborts when the server holds the connection past the deadline", async () => {
    const r = await webfetchTool(
      { url: `${baseUrl}/slow` },
      ctxAllow({ perCallTimeoutMs: 300 }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("timeout");
  }, 5_000);
});

// ─── Bad args ────────────────────────────────────────────────────────

describe("webfetch — bad inputs", () => {
  it("rejects missing url", async () => {
    const r = await webfetchTool({} as JsonObject, ctxAllow());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("bad_args");
  });

  it("rejects a malformed URL string", async () => {
    const r = await webfetchTool({ url: "http://" }, ctxAllow());
    expect(r.ok).toBe(false);
    // Either bad_url upstream or a downstream parse failure
    expect(["bad_url", "disallowed_scheme"]).toContain(r.audit.error);
  });

  it("rejects a non-string url", async () => {
    const r = await webfetchTool({ url: 42 as unknown as string }, ctxAllow());
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("bad_args");
  });
});
