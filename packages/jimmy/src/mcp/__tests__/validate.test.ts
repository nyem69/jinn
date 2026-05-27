import { describe, it, expect, vi, beforeEach } from "vitest";

const probeServer = vi.fn();
const opsAlert = vi.fn();
vi.mock("../probe.js", () => ({ probeServer: (...a: unknown[]) => probeServer(...a) }));
vi.mock("../../shared/ops-alert.js", () => ({ opsAlert: (...a: unknown[]) => opsAlert(...a) }));

import { validateServers, _clearCache } from "../validate.js";

beforeEach(() => { probeServer.mockReset(); opsAlert.mockReset(); _clearCache(); });

const clean = { command: "good", args: [] };
const poison = { command: "bad", args: [] };

describe("validateServers", () => {
  it("keeps clean servers", async () => {
    probeServer.mockResolvedValue({ tools: [{ name: "x", inputSchema: { type: "object" } }] });
    const r = await validateServers({ good: clean });
    expect(Object.keys(r.servers)).toEqual(["good"]);
    expect(r.quarantined).toEqual([]);
    expect(opsAlert).not.toHaveBeenCalled();
  });

  it("drops + alerts a server with a top-level combinator", async () => {
    probeServer.mockResolvedValue({ tools: [{ name: "find_cheapest", inputSchema: { type: "object", anyOf: [{ required: ["a"] }] } }] });
    const r = await validateServers({ bad: poison });
    expect(Object.keys(r.servers)).toEqual([]);
    expect(r.quarantined[0]).toMatchObject({ server: "bad", tool: "find_cheapest", reason: "anyOf" });
    expect(opsAlert).toHaveBeenCalledOnce();
  });

  it("keeps a server that is merely down (transient, not poison)", async () => {
    probeServer.mockResolvedValue({ tools: null, error: "timeout" });
    const r = await validateServers({ good: clean });
    expect(Object.keys(r.servers)).toEqual(["good"]);
    expect(opsAlert).not.toHaveBeenCalled();
  });

  it("caches: second call does not re-probe", async () => {
    probeServer.mockResolvedValue({ tools: [{ name: "x", inputSchema: { type: "object" } }] });
    await validateServers({ good: clean });
    await validateServers({ good: clean });
    expect(probeServer).toHaveBeenCalledOnce();
  });
});
