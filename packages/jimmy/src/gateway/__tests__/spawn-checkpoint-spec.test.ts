import { describe, it, expect } from "vitest";
import { buildSpawnCheckpointSpec } from "../api.js";

// T1A.PR8 follow-up: api.ts wires `body.checkpoint` into createSession
// for delegations (POST /api/sessions, /api/cross-request). The helper
// merges caller-supplied state with sane defaults so existing callers
// that don't know about the checkpoint surface still write a baseline
// row. These tests cover the merge logic; the underlying
// writeSpawnCheckpoint mechanics (monotonic step_seq, branch
// isolation, dedup) live in sessions/__tests__/spawn-checkpoint.test.ts.
//
// The stepSeq-from-max(seq) lookup branch is intentionally not exercised
// here because it engages initDb()/the on-disk sessions registry; the
// fallback path (caller-supplied stepSeq wins, otherwise the
// per-branch monotonic counter inside writeSpawnCheckpoint takes over)
// is already covered by the spawn-checkpoint suite.

describe("buildSpawnCheckpointSpec", () => {
  it("returns undefined when caller passes nothing AND no defaults exist", () => {
    expect(buildSpawnCheckpointSpec(undefined, {})).toBeUndefined();
    expect(buildSpawnCheckpointSpec({}, {})).toBeUndefined();
  });

  it("synthesises {persona, prompt} from defaults when caller passes nothing", () => {
    const spec = buildSpawnCheckpointSpec(undefined, {
      employee: "writer",
      prompt: "compose a haiku",
    });
    expect(spec).toBeDefined();
    expect(spec!.state).toEqual({ persona: "writer", prompt: "compose a haiku" });
    expect(spec!.stepSeq).toBeUndefined();
    expect(spec!.branch).toBeUndefined();
  });

  it("populates only the keys it has — partial defaults stay partial", () => {
    expect(buildSpawnCheckpointSpec(undefined, { employee: "writer" })!.state).toEqual({
      persona: "writer",
    });
    expect(buildSpawnCheckpointSpec(undefined, { prompt: "go" })!.state).toEqual({
      prompt: "go",
    });
  });

  it("merges defaults with caller state; caller wins on conflict", () => {
    const spec = buildSpawnCheckpointSpec(
      { checkpoint: { state: { persona: "explicit", extra_key: 42 } } },
      { employee: "default-employee", prompt: "default-prompt" },
    );
    expect(spec!.state).toEqual({
      persona: "explicit",            // caller overrode
      prompt: "default-prompt",       // default kept
      extra_key: 42,                  // caller-only key preserved
    });
  });

  it("passes branch through from caller checkpoint", () => {
    const spec = buildSpawnCheckpointSpec(
      { checkpoint: { branch: "fork-a", state: { persona: "x" } } },
      { employee: "default" },
    );
    expect(spec!.branch).toBe("fork-a");
  });

  it("passes caller-supplied stepSeq through verbatim", () => {
    const spec = buildSpawnCheckpointSpec(
      { checkpoint: { stepSeq: 99, state: {} } },
      { employee: "x" },
    );
    expect(spec!.stepSeq).toBe(99);
  });

  it("includes extra default keys (used by cross-request to record route metadata)", () => {
    const spec = buildSpawnCheckpointSpec(undefined, {
      employee: "provider",
      prompt: "do thing",
      extra: {
        cross_request: {
          from_employee: "requester",
          service: "translate",
          route: "requester -> manager -> provider",
        },
      },
    });
    expect(spec!.state).toMatchObject({
      persona: "provider",
      prompt: "do thing",
      cross_request: {
        from_employee: "requester",
        service: "translate",
      },
    });
  });

  it("caller checkpoint with empty state still kicks in defaults", () => {
    const spec = buildSpawnCheckpointSpec(
      { checkpoint: { state: {} } },
      { employee: "fallback" },
    );
    expect(spec!.state).toEqual({ persona: "fallback" });
  });
});
