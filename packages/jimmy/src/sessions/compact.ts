import type { JinnConfig } from "../shared/types.js";
import { getMessages, replaceMessages, updateSession, type SessionMessage } from "./registry.js";
import { logger } from "../shared/logger.js";

// ── Config ──────────────────────────────────────────────────────────

export interface CompactionConfig {
  enabled: boolean;
  maxEstimatedTokens: number;
  preserveRecentMessages: number;
}

const DEFAULT_COMPACTION: CompactionConfig = {
  enabled: true,
  maxEstimatedTokens: 50_000,
  preserveRecentMessages: 6,
};

export function resolveCompactionConfig(config: JinnConfig): CompactionConfig {
  const c = config.sessions?.compaction;
  if (!c || c.enabled === false) {
    return { ...DEFAULT_COMPACTION, enabled: false };
  }
  return {
    enabled: true,
    maxEstimatedTokens: c.maxEstimatedTokens ?? DEFAULT_COMPACTION.maxEstimatedTokens,
    preserveRecentMessages: c.preserveRecentMessages ?? DEFAULT_COMPACTION.preserveRecentMessages,
  };
}

// ── Token estimation ────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 1;
}

// ── Compaction check ────────────────────────────────────────────────

export interface CompactionCheck {
  needed: boolean;
  messageCount: number;
  estimatedTokens: number;
}

export function shouldCompact(sessionId: string, config: CompactionConfig): CompactionCheck {
  const messages = getMessages(sessionId);
  const messageCount = messages.length;
  if (messageCount <= config.preserveRecentMessages) {
    return { needed: false, messageCount, estimatedTokens: 0 };
  }
  const estimatedTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  return {
    needed: estimatedTokens >= config.maxEstimatedTokens,
    messageCount,
    estimatedTokens,
  };
}

// ── Summary builder ─────────────────────────────────────────────────

const FILE_RE = /(?:^|\s|['"`(])([.\w/-]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|py|rs|sql|svelte|vue|css|html))\b/g;
const PENDING_RE = /\b(?:todo|next|pending|fix|investigate|follow[- ]?up|remaining)\b/i;
const EMPLOYEE_RE = /@([\w-]+)/g;

function extractPatterns(text: string, re: RegExp): string[] {
  const results = new Set<string>();
  let match: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((match = re.exec(text)) !== null) {
    results.add(match[1] ?? match[0]);
  }
  return [...results];
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\n/g, " ").trim();
  return cleaned.length > max ? cleaned.slice(0, max) + "…" : cleaned;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export function buildSummary(messages: SessionMessage[]): string {
  if (messages.length === 0) return "";

  const roleCounts: Record<string, number> = {};
  for (const m of messages) {
    roleCounts[m.role] = (roleCounts[m.role] ?? 0) + 1;
  }

  const first = messages[0]!;
  const last = messages[messages.length - 1]!;

  // Previous summary content (for re-compaction)
  let previousSummary = "";
  const startIdx = first.role === "summary" ? 1 : 0;
  if (first.role === "summary") {
    previousSummary = first.content;
  }

  // Recent user requests (last 3 user messages in the compacted set)
  const userMessages = messages.slice(startIdx).filter((m) => m.role === "user");
  const recentRequests = userMessages.slice(-3).map((m) => truncate(m.content, 200));

  // Extract key topics across all messages
  const allText = messages.slice(startIdx).map((m) => m.content).join("\n");
  const files = extractPatterns(allText, FILE_RE).slice(0, 8);
  const employees = extractPatterns(allText, EMPLOYEE_RE).slice(0, 6);

  // Pending work items
  const pendingItems = messages
    .slice(startIdx)
    .filter((m) => PENDING_RE.test(m.content))
    .slice(-5)
    .map((m) => truncate(m.content, 150));

  // Key timeline (one line per message, condensed)
  const timeline = messages.slice(startIdx).map((m) => {
    const ts = formatTimestamp(m.timestamp);
    const brief = truncate(m.content, 80);
    return `- [${ts}] ${m.role}: ${brief}`;
  });

  const sections: string[] = [];
  sections.push(`[Session Summary — Compacted ${messages.length} messages]`);
  sections.push("");

  const scopeParts = Object.entries(roleCounts)
    .filter(([role]) => role !== "summary")
    .map(([role, count]) => `${count} ${role}`)
    .join(", ");
  sections.push(`## Scope`);
  sections.push(`${scopeParts} | ${formatTimestamp(first.timestamp)} → ${formatTimestamp(last.timestamp)}`);

  if (previousSummary) {
    sections.push("");
    sections.push(`## Previous summary`);
    sections.push(previousSummary);
  }

  if (recentRequests.length > 0) {
    sections.push("");
    sections.push(`## Recent user requests`);
    recentRequests.forEach((r, i) => sections.push(`${i + 1}. ${r}`));
  }

  if (files.length > 0 || employees.length > 0) {
    sections.push("");
    sections.push(`## Key topics`);
    if (files.length > 0) sections.push(`Files: ${files.join(", ")}`);
    if (employees.length > 0) sections.push(`Employees: ${employees.join(", ")}`);
  }

  if (pendingItems.length > 0) {
    sections.push("");
    sections.push(`## Pending work`);
    pendingItems.forEach((item) => sections.push(`- ${item}`));
  }

  if (timeline.length > 0) {
    sections.push("");
    sections.push(`## Timeline`);
    if (timeline.length <= 20) {
      sections.push(...timeline);
    } else {
      const step = Math.ceil(timeline.length / 20);
      for (let i = 0; i < timeline.length; i += step) {
        sections.push(timeline[i]!);
      }
      sections.push(timeline[timeline.length - 1]!);
    }
  }

  return sections.join("\n");
}

// ── Compaction ──────────────────────────────────────────────────────

/**
 * Compact a session's stored messages: summarize older messages, replace
 * them with a single "summary" message, preserve recent messages.
 * Returns the number of messages removed, or 0 if not needed.
 */
export function compactSession(sessionId: string, config: CompactionConfig): number {
  const check = shouldCompact(sessionId, config);
  if (!check.needed) return 0;

  const messages = getMessages(sessionId);
  const splitAt = Math.max(0, messages.length - config.preserveRecentMessages);
  const toCompact = messages.slice(0, splitAt);
  const preserved = messages.slice(splitAt);

  if (toCompact.length === 0) return 0;

  // Guard: don't compact if preserved window already contains a summary
  if (preserved.some((m) => m.role === "summary")) return 0;

  const summary = buildSummary(toCompact);
  const deleteIds = toCompact.map((m) => m.id);
  const summaryTimestamp = toCompact[0]!.timestamp;

  replaceMessages(sessionId, deleteIds, {
    role: "summary",
    content: summary,
    timestamp: summaryTimestamp,
  });

  updateSession(sessionId, { compactedAt: new Date().toISOString() });

  logger.info(
    `Compacted session ${sessionId}: ${toCompact.length} messages -> summary (${estimateTokens(summary)} est. tokens), preserved ${preserved.length} recent`,
  );

  return toCompact.length;
}
