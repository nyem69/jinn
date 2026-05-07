import { z } from "zod";

// T1A.PR2: Canonical event-kind schemas. Adding a new kind = adding a
// key here and a handler set entry. No DB migration is needed -- the
// `kind` column on session_events is free-form text. Schemas are the
// contract between emitters (engine parsers, skill harnesses) and
// consumers (handlers, SSE readers, replay).

const Quality = z.enum(["excellent", "good", "fair", "poor"]);
const Outcome = z.enum(["success", "partial", "failed", "blocked"]);

export const EventSchemas = {
  session_started: z.object({
    employee: z.string().min(1),
    oversight: z.enum(["TRUST", "VERIFY", "THOROUGH"]),
    brief: z.string(),
  }),

  session_completed: z.object({
    state: z.enum(["completed", "max_iterations", "error", "cancelled"]),
    tokens_in: z.number().int().nonnegative(),
    tokens_out: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
    cost_usd: z.number().nullable(),
    step_count: z.number().int().nonnegative(),
    tool_call_count: z.number().int().nonnegative(),
    final_answer: z.string().nullable(),
    error_message: z.string().nullable(),
  }),

  subagent_spawned: z.object({
    child_session_id: z.string().min(1),
    kind: z.string(),
    brief: z.string(),
  }),

  subagent_completed: z.object({
    child_session_id: z.string().min(1),
    quality: Quality,
    outcome: Outcome,
  }),

  // skill_invoked carries a short summary; full args go through
  // tool_invoked when the engine wraps the skill call as a tool.
  skill_invoked: z.object({
    skill: z.string().min(1),
    args_summary: z.string().max(500),
  }),

  // tool_invoked + tool_completed share the call_id so the parser can
  // pair them at read time. tool_completed.error is set on engine-side
  // failure; tool_invoked.args is the full input -- this is what makes
  // replay possible.
  tool_invoked: z.object({
    tool: z.string().min(1),
    call_id: z.string().min(1),
    args: z.unknown(),
  }),

  tool_completed: z.object({
    tool: z.string().min(1),
    call_id: z.string().min(1),
    result: z.unknown().nullable(),
    error: z.string().nullable(),
    duration_ms: z.number().int().nonnegative(),
  }),

  validator_failure: z.object({
    skill: z.string().min(1),
    check: z.string().min(1),
    message: z.string(),
  }),

  validator_hard_fail: z.object({
    skill: z.string().min(1),
    iterations: z.number().int().positive(),
  }),

  assistant_message: z.object({
    text: z.string(),
    message_id: z.string().min(1),
  }),
} as const;

export type EventKind = keyof typeof EventSchemas;

export function isKnownKind(kind: string): kind is EventKind {
  return Object.prototype.hasOwnProperty.call(EventSchemas, kind);
}

export interface ValidationOk {
  ok: true;
  payload: unknown;
}

export interface ValidationErr {
  ok: false;
  // Field-level error; the API surfaces this so the writer can fix the
  // payload without guessing what failed.
  errors: Array<{ path: string; message: string }>;
}

export function validateEvent(kind: string, payload: unknown): ValidationOk | ValidationErr {
  if (!isKnownKind(kind)) {
    return {
      ok: false,
      errors: [{ path: "kind", message: `unknown event kind: ${kind}` }],
    };
  }
  const schema = EventSchemas[kind];
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, payload: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((iss) => ({
      path: iss.path.join("."),
      message: iss.message,
    })),
  };
}
