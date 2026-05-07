import fs from 'node:fs';
import {
  buildReplayContext,
  type ReplayContextResult,
} from '../sessions/checkpoint.js';

// `jinn replay <session-id> [--from-step N] [--branch <name>]
//                           [--to-branch <name>] [--edit-prompt <file>]
//                           [--print]`
//
// PR5 ships the read-side: the CLI prints (or persists into a follow-up
// flag) the replay context so an operator can inspect what would be
// fed into a new child session. Spawning the new child is the engine
// integration step — it requires per-engine wiring to feed pre-recorded
// tool results back as observations. That follow-up will reuse this
// same buildReplayContext output.
//
// Replay determinism is not bit-exact — LLMs are sampled. The CLI's
// help text states this; the operator knows to treat the result as
// "rerun with same inputs", not "reproduce byte-for-byte".

export interface RunReplayOpts {
  sessionId: string;
  fromStep?: number;
  branch?: string;
  toBranch?: string;
  editPrompt?: string;
  print?: boolean;
}

export async function runReplay(opts: RunReplayOpts): Promise<void> {
  if (!opts.sessionId) {
    console.error('Error: session-id is required');
    process.exit(2);
  }

  const ctx = buildReplayContext(opts.sessionId, {
    branch: opts.branch,
    fromStep: opts.fromStep,
    toBranch: opts.toBranch,
  });

  if (!ctx.ok) {
    printReplayError(ctx, opts.sessionId);
    process.exit(1);
  }

  // Splice in --edit-prompt content if provided. The new prompt
  // overrides the checkpoint's saved prompt; the rest of the
  // reconstructed state stays as-is.
  let editedPrompt: string | undefined;
  if (opts.editPrompt) {
    if (!fs.existsSync(opts.editPrompt)) {
      console.error(`Error: --edit-prompt file not found: ${opts.editPrompt}`);
      process.exit(2);
    }
    editedPrompt = fs.readFileSync(opts.editPrompt, 'utf-8');
  }

  const renderable = {
    ...ctx,
    checkpoint: editedPrompt
      ? {
          ...ctx.checkpoint,
          state: { ...ctx.checkpoint.state, prompt: editedPrompt },
        }
      : ctx.checkpoint,
  };

  if (opts.print) {
    console.log(JSON.stringify(renderable, null, 2));
    return;
  }

  // Default: human-readable summary. Spawning the new child session is
  // a per-engine integration not in this PR's scope; print a clear
  // message so the operator knows what's missing.
  printReplaySummary(renderable);
  console.log('');
  console.log(
    'Note: actual replay execution (feeding tool sequence into a fresh child) requires engine-side wiring.',
  );
  console.log('     Use --print to dump the full context as JSON for downstream tools.');
}

function printReplayError(ctx: Extract<ReplayContextResult, { ok: false }>, sessionId: string): void {
  switch (ctx.reason) {
    case 'unknown_session':
      console.error(`Error: session not found: ${sessionId}`);
      return;
    case 'no_checkpoints':
      console.error(`Error: no checkpoints recorded for session ${sessionId} on the requested branch`);
      return;
    case 'step_out_of_bounds':
      console.error(
        `Error: requested step is out of bounds. Available steps on this branch: ${ctx.available.join(', ')}`,
      );
      return;
  }
}

function printReplaySummary(
  ctx: Extract<ReplayContextResult, { ok: true }>,
): void {
  const cp = ctx.checkpoint;
  const persona = (cp.state.persona as string | undefined) ?? '(no persona)';
  const promptLen =
    typeof cp.state.prompt === 'string' ? (cp.state.prompt as string).length : 0;

  console.log(`Replay context for session ${ctx.session.sessionId}`);
  console.log(`  engine: ${ctx.session.engine}, model: ${ctx.session.model ?? '(default)'}`);
  console.log(`  employee: ${ctx.session.employee ?? '(none)'}`);
  console.log(`  parent: ${ctx.session.parentSessionId ?? '(top-level)'}`);
  console.log('');
  console.log(`Checkpoint @ step ${cp.stepSeq} on branch '${cp.branch}'`);
  console.log(`  persona: ${persona}`);
  console.log(`  prompt: ${promptLen} chars`);
  console.log(`  active_plan keys: ${objectKeys(cp.state.active_plan)}`);
  console.log(`  prior_results keys: ${objectKeys(cp.state.prior_results)}`);
  console.log('');
  console.log(`Tool sequence (${ctx.toolSequence.length} entries to replay):`);
  for (const t of ctx.toolSequence.slice(0, 20)) {
    const status = t.error ? `error` : t.result == null ? 'pending' : 'ok';
    console.log(`  - ${t.tool} (call_id=${t.callId}, ${status})`);
  }
  if (ctx.toolSequence.length > 20) {
    console.log(`  ... and ${ctx.toolSequence.length - 20} more`);
  }
  console.log('');
  console.log(`Forked branch: '${ctx.toBranch}' (next step_seq: ${ctx.nextStepSeq})`);
}

function objectKeys(v: unknown): string {
  if (v == null || typeof v !== 'object') return '(none)';
  const keys = Object.keys(v as Record<string, unknown>);
  return keys.length > 0 ? keys.join(', ') : '(empty)';
}
