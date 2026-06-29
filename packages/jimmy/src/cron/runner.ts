import type { BuiltInEngineName, CronJob, Connector, JinnConfig } from "../shared/types.js";
import { modelFor } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { appendRunLog } from "./jobs.js";
import { scanOrg, findEmployee } from "../gateway/org.js";
import { CronConnector } from "../connectors/cron/index.js";
import type { SessionManager } from "../sessions/manager.js";
import { resolveJobBudget, SESSION_BUDGET_STOP_PREFIX } from "../sessions/budget.js";
import { getSession } from "../sessions/registry.js";
import { opsAlert } from "../shared/ops-alert.js";
import { runPrecheck } from "./precheck.js";

/** Provenance for a catch-up replay (a fire the host slept through). */
export interface CronRunMeta {
  catchUp?: boolean;
  /** ISO timestamp of the scheduled fire being replayed. */
  scheduledFor?: string;
  /** In-window earlier occurrences collapsed by the latest-only policy. */
  olderFiresSkipped?: number;
}

/**
 * ms epoch of each job's most recent *start*, recorded synchronously the moment
 * runCronJob is invoked — i.e. before the (often multi-minute) LLM session it
 * awaits. The run-log on disk is only written when the session COMPLETES, so a
 * job that is still running has no fresh disk entry; without this, the ~5-min
 * catch-up sweep sees a stale run-log and wrongly replays the slot the live
 * scheduler already fired (every cron whose runtime outlasts the gap to the next
 * sweep would double-fire). Catch-up dedup consults this alongside the disk log.
 *
 * Intentionally in-memory only: lost on process restart, which is correct — a
 * fresh start must fall back to the on-disk run-log so genuinely-missed fires
 * (slept/crashed through) still replay.
 */
const lastStartedAt = new Map<string, number>();

/** ms epoch of a job's most recent in-process start, or null if none this run. */
export function lastStartedAtMs(jobId: string): number | null {
  return lastStartedAt.get(jobId) ?? null;
}

export async function runCronJob(
  job: CronJob,
  sessionManager: SessionManager,
  config: JinnConfig,
  connectors: Map<string, Connector>,
  meta?: CronRunMeta,
): Promise<void> {
  lastStartedAt.set(job.id, Date.now());
  const catchUpFields = meta?.catchUp
    ? {
        catchUp: true,
        scheduledFor: meta.scheduledFor ?? null,
        olderFiresSkipped: meta.olderFiresSkipped ?? 0,
      }
    : {};
  const startTime = Date.now();
  logger.info(`Cron job "${job.name}" (${job.id}) starting`);

  // Deterministic pre-gate: run a cheap shell check BEFORE creating the
  // (expensive) LLM session, and skip the session entirely when there's no
  // work. See CronJob.precheck for the exit-code contract.
  if (job.precheck) {
    const precheckStartedAt = new Date().toISOString();
    const pc = await runPrecheck(job.precheck);
    if (pc.decision !== "proceed") {
      const durationMs = Date.now() - startTime;
      const isSkip = pc.decision === "skip";
      appendRunLog(job.id, {
        timestamp: precheckStartedAt,
        sessionKey: null,
        sessionId: null,
        status: isSkip ? "gated-skip" : "precheck_error",
        durationMs,
        precheck: {
          exitCode: pc.exitCode,
          timedOut: pc.timedOut,
          durationMs: pc.durationMs,
          stderr: pc.stderr.slice(0, 500),
        },
        error: isSkip
          ? null
          : `precheck failed (exit ${pc.exitCode ?? "?"}${pc.timedOut ? ", timed out" : ""}): ${pc.stderr.slice(0, 200)}`,
        ...catchUpFields,
        resultPreview: null,
      });
      if (isSkip) {
        logger.info(
          `Cron job "${job.name}" (${job.id}) gated-skip via precheck (exit ${pc.exitCode}) in ${durationMs}ms`,
        );
      } else {
        logger.error(
          `Cron job "${job.name}" (${job.id}) precheck error (exit ${pc.exitCode ?? "none"}, timedOut=${pc.timedOut})`,
        );
        // A precheck ERROR is an unexpected failure (not a normal no-work skip) — surface it.
        await opsAlert(
          `Cron "${job.name}" (${job.id}) precheck FAILED — exit ${pc.exitCode ?? "none"}${pc.timedOut ? " (timed out)" : ""}. ` +
            `No session was spawned. stderr: ${pc.stderr.slice(0, 300) || "(none)"}`,
        ).catch(() => {});
      }
      return;
    }
    logger.debug(
      `Cron job "${job.name}" (${job.id}) precheck passed (exit 0) in ${pc.durationMs}ms — proceeding`,
    );
  }

  const delivery = job.delivery || config.cron?.defaultDelivery;
  const cooSlug = config.portal?.portalName?.toLowerCase() || "jinn";
  if (delivery && job.employee && job.employee !== cooSlug) {
    logger.debug(
      `Cron job "${job.name}" targets employee "${job.employee}" directly (skipping COO delegation).`,
    );
  }

  let employee;
  if (job.employee) {
    const orgRegistry = scanOrg();
    employee = findEmployee(job.employee, orgRegistry);
  }

  const budget = resolveJobBudget(job, config);

  const connector = new CronConnector(connectors, delivery);
  const startedAt = new Date().toISOString();
  const sessionKey = `cron:${job.id}:${Date.now()}`;

  try {
    const routeResult = await sessionManager.route(
      {
        connector: connector.name,
        source: "cron",
        sessionKey,
        replyContext: {
          channel: delivery?.channel || job.id,
          messageTs: null,
          cronJobId: job.id,
          cronJobName: job.name,
          deliveryConnector: delivery?.connector ?? null,
        },
        messageId: undefined,
        channel: delivery?.channel || job.id,
        thread: undefined,
        user: "system",
        userId: "system",
        text: job.prompt,
        attachments: [],
        raw: { jobId: job.id, trigger: "cron" },
        transportMeta: {
          cronJobId: job.id,
          cronJobName: job.name,
          deliveryConnector: delivery?.connector ?? null,
          deliveryChannel: delivery?.channel ?? null,
          sessionBudget: { maxTurns: budget.maxTurns, sideEffects: budget.sideEffects },
        },
      },
      connector,
      {
        employee,
        engine: job.engine || employee?.engine || config.engines.default,
        model: job.model || employee?.model || modelFor(config.engines, (job.engine || config.engines.default) as BuiltInEngineName),
        title: job.name,
      },
    );

    const durationMs = Date.now() - startTime;
    const finalSession = routeResult?.sessionId ? getSession(routeResult.sessionId) : undefined;
    const budgetStopped = !!finalSession?.lastError?.startsWith(SESSION_BUDGET_STOP_PREFIX);
    // A session can end in ERROR without route() throwing: the engine rejects
    // (e.g. "Failed to spawn Claude CLI" / "engine never started"), the session
    // manager catches it, records session.status="error"+lastError, and route()
    // still RESOLVES with a sessionId. Without this check those land as
    // "success"/"completed" with no alert — the exact failure mode behind the
    // Jun-2026 silent cron outage (a moved Claude binary ENOENT'd ~400 fires,
    // every one logged "completed in 16ms"). Treat a non-budget session error as
    // a cron failure: record it and fire an ops-alert.
    const sessionErrored = !budgetStopped && finalSession?.status === "error";
    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      sessionId: routeResult?.sessionId ?? null,
      status: budgetStopped ? "session_budget_stop" : sessionErrored ? "error" : "success",
      durationMs,
      error: budgetStopped
        ? finalSession?.lastError ?? null
        : sessionErrored
          ? finalSession?.lastError ?? "session ended in error"
          : null,
      ...(budgetStopped ? { maxTurns: budget.maxTurns, actualTurns: finalSession?.totalTurns ?? null } : {}),
      ...catchUpFields,
      resultPreview: null,
    });
    if (budgetStopped && budget.sideEffects) {
      await opsAlert(
        `Cron "${job.name}" (${job.id}) hit its turn-budget cap (${budget.maxTurns}) and was stopped mid-task ` +
        `after ~${finalSession?.totalTurns ?? "?"} turns. This job is flagged sideEffects:true — check for partial external writes.`,
      ).catch(() => {});
    }
    if (sessionErrored) {
      logger.error(
        `Cron job "${job.name}" (${job.id}) session ended in error in ${durationMs}ms: ${finalSession?.lastError ?? "(no message)"}`,
      );
      await opsAlert(
        `Cron "${job.name}" (${job.id}) FAILED — session ended in error (engine never produced a result, no exception thrown). ` +
          `${finalSession?.lastError?.slice(0, 300) ?? "(no error message)"}`,
      ).catch(() => {});
    } else {
      logger.info(`Cron job "${job.name}" ${budgetStopped ? "stopped at turn budget" : "completed"} in ${durationMs}ms`);
    }

    // Latency alert: warn if job exceeded threshold
    const thresholdMs = config.cron?.alertThresholdMs;
    if (thresholdMs && durationMs > thresholdMs) {
      const alertConnector = config.cron?.alertConnector;
      const alertChannel = config.cron?.alertChannel;
      if (alertConnector && alertChannel) {
        const alertTarget = connectors.get(alertConnector);
        if (alertTarget) {
          const mins = (durationMs / 60_000).toFixed(1);
          const threshMins = (thresholdMs / 60_000).toFixed(1);
          await alertTarget.sendMessage(
            { channel: alertChannel },
            `🐢 Cron latency alert: "${job.name}" (${job.id}) exceeded threshold — took ${mins}min (threshold: ${threshMins}min). Session: ${routeResult?.sessionId ?? "unknown"}`,
          ).catch((alertErr) => {
            logger.error(`Failed to send latency alert: ${alertErr instanceof Error ? alertErr.message : alertErr}`);
          });
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      status: "error",
      durationMs: Date.now() - startTime,
      error: message,
      ...catchUpFields,
      resultPreview: null,
    });
    logger.error(`Cron job "${job.name}" failed: ${message}`);

    // Send alert if configured
    const alertConnector = config.cron?.alertConnector;
    const alertChannel = config.cron?.alertChannel;
    if (alertConnector && alertChannel) {
      const alertTarget = connectors.get(alertConnector);
      if (alertTarget) {
        await alertTarget.sendMessage(
          { channel: alertChannel },
          `⚠️ Cron job "${job.name}" failed:\n${message.slice(0, 500)}`,
        ).catch((alertErr) => {
          logger.error(`Failed to send cron alert: ${alertErr instanceof Error ? alertErr.message : alertErr}`);
        });
      }
    }
  }
}
