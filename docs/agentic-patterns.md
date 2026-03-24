# Agentic Design Patterns for Jinn

This document describes the agentic design patterns implemented in the `feat/agentic-patterns` branch, inspired by the [Agentic Design Patterns](https://github.com/Mathews-Tom/Agentic-Design-Patterns) book.

## Overview

Jinn already implements several agentic patterns natively (delegation, tool use, routing, planning). This branch adds three gateway-level features and a set of instance-layer protocols that bring the remaining patterns into production.

### Gateway changes (4 files, +117 lines)

| Feature | Files | Description |
|---------|-------|-------------|
| Session timeout enforcement | `api.ts`, `manager.ts`, `types.ts` | Kill runaway sessions after a configurable duration |
| `invoke_employee` MCP tool | `gateway-server.ts` | Synchronous inline employee invocation for sub-tasks |
| MCP config injection for web sessions | `api.ts` | Web-created sessions now receive MCP server config (parity with connector path) |

### Instance-layer changes (no source code)

Protocols added to `~/.jinn/CLAUDE.md`, skills in `~/.jinn/skills/`, and knowledge files in `~/.jinn/knowledge/`. These are prompt-level patterns that guide the COO (jin) without requiring gateway code changes.

## Feature Details

### 1. Session Timeout Enforcement

**Problem:** Sessions could run indefinitely, consuming resources and blocking queues. No mechanism existed to enforce time limits.

**Solution:** Added `maxDurationMinutes` support at two levels:
- **Global config:** `sessions.maxDurationMinutes` in `config.yaml`
- **Per-employee:** `maxDurationMinutes` field in employee YAML

The timeout is enforced in both run paths (connector via `manager.ts` and web API via `api.ts`). When the timer fires, the engine process is killed via SIGTERM. If no engine process exists (session queued but not yet started), the session is marked as interrupted directly.

**Config example:**
```yaml
sessions:
  maxDurationMinutes: 30
```

**Per-employee override:**
```yaml
# org/historian.yaml
maxDurationMinutes: 10
```

**Resolution order:** employee setting > global config > no limit.

**Edge case handled:** When the timeout fires but `engine.kill()` is a no-op (no live process mapped), the session is force-marked as `interrupted` with a descriptive error. This prevents zombie sessions that stay "running" forever.

### 2. `invoke_employee` MCP Tool

**Problem:** Employees could delegate to other employees via `create_child_session`, but this is asynchronous — the caller has to poll or wait for an `onComplete` callback. For quick sub-tasks (fact-checks, lookups, formatting), this added unnecessary complexity.

**Solution:** Added `invoke_employee` to the gateway MCP server. It creates a child session, polls every 2 seconds until completion, and returns the result inline.

**MCP tool schema:**
```json
{
  "name": "invoke_employee",
  "inputSchema": {
    "type": "object",
    "properties": {
      "employee": { "type": "string" },
      "prompt": { "type": "string" },
      "parentSessionId": { "type": "string" },
      "timeoutSeconds": { "type": "number", "default": 300 }
    },
    "required": ["employee", "prompt"]
  }
}
```

**Return format:**
```json
{
  "sessionId": "uuid",
  "employee": "historian",
  "status": "idle",
  "result": "The assistant's response text...",
  "error": null,
  "cost": 0.12,
  "durationMs": 16045
}
```

**Use case:** An employee working on political analysis can call `invoke_employee` with the historian to get a quick fact-check without leaving their current context.

### 3. MCP Config Injection for Web Sessions

**Problem:** Sessions created via the web API (`POST /api/sessions`) did not receive MCP server configuration. Only connector-based sessions (Telegram, Slack) got MCP tools injected via `manager.ts`. This meant web-created employee sessions couldn't use gateway MCP tools.

**Solution:** Added MCP config resolution and injection in `runWebSession()` in `api.ts`, mirroring the existing logic in `manager.ts`. The MCP config file is written before `engine.run()` and cleaned up in the `.finally()` block.

## Instance-Layer Patterns

These patterns are implemented as prompts and protocols in `~/.jinn/`, requiring no gateway code changes.

| Pattern | Location | Description |
|---------|----------|-------------|
| Producer-Critic Loop | `CLAUDE.md` | THOROUGH oversight iterates up to 3 rounds |
| Fan-out/Fan-in Synthesis | `CLAUDE.md` | Cross-reference parallel employee outputs before delivering |
| Fallback Chains | `CLAUDE.md` | Retry > switch engine > reassign > escalate |
| Adaptive Re-planning | `CLAUDE.md` | Re-assess and adjust when plans break mid-execution |
| SMART Delegation | `CLAUDE.md` | Structured task prompts with success criteria |
| Context Pruning | `CLAUDE.md` | Summarize context before delegating to reduce token cost |
| Priority Levels | `CLAUDE.md` | P0/P1/P2 triage with mapped oversight levels |
| Session-to-Memory Pipeline | `CLAUDE.md` | Persist valuable outcomes from child sessions to knowledge files |
| Debate Pattern | `skills/debate/SKILL.md` | Multi-perspective analysis with 2-3 employees |
| Delegation Template | `skills/delegation-template/SKILL.md` | SMART goal template for structured delegation |
| Performance Archive | `knowledge/employee-performance.json` | Track employee task success rates and quality |
| Episodic Memory | `knowledge/episodes/INDEX.md` | Store successful task trajectories for reference |
| Session Health Monitoring | `CLAUDE.md` | Detect stagnation in child sessions |

## Patterns Deferred

| Pattern | Reason | Prerequisite |
|---------|--------|-------------|
| Voting/Verification | Needs structured output parsing | Gateway support for typed responses |
| Guardrails (input/output) | Needs middleware pipeline | Pre/post hooks in session lifecycle |
| Dynamic Model Selection | Needs latency/cost telemetry | Metrics collection infrastructure |

## Testing

All features were tested against a live gateway:

| Test | Result | Details |
|------|--------|---------|
| Session timeout (1min) | Pass | Session killed at exactly 60s, SIGTERM exit code 143 |
| Timeout with no engine process | Pass | Session marked interrupted with descriptive error |
| `invoke_employee` via API | Pass | historian returned GE14 fact-check in 16s |
| `invoke_employee` via MCP | Pass | historian returned May 13 analysis in 16s |
| Debate skill (parallel) | Pass | machiavelli + sociologist in ~52s, synthesized by jin |
| MCP injection for web sessions | Pass | Employees receive gateway tools in web-created sessions |
| Config hot-reload | Pass | `maxDurationMinutes` change picked up without restart |
