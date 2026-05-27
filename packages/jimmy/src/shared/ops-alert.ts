import { logger } from "./logger.js";

/** Ops/error chat (CLAUDE.md: Telegram 535655138 is reserved for infra/ops alerts). */
const OPS_CHAT_ID = process.env.OPS_TELEGRAM_CHAT_ID || "535655138";

/** Send a one-line ops alert to Telegram. Always logs; Telegram is best-effort
 *  and never throws into the caller (a missing token must not break a session). */
export async function opsAlert(text: string): Promise<void> {
  logger.warn(`[ops-alert] ${text}`);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: OPS_CHAT_ID, text: `🚨 ${text}` }),
    });
  } catch (e) {
    logger.warn(`[ops-alert] telegram send failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
