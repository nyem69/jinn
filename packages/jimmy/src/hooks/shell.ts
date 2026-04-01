import { spawn } from "node:child_process";
import { logger } from "../shared/logger.js";

/**
 * Run a shell hook command. Pipes JSON payload to stdin, reads stdout.
 * Returns stdout string on success, null on failure/timeout.
 */
export function runShellHook(
  command: string,
  payload: Record<string, unknown>,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const args = process.platform === "win32" ? ["/c", command] : ["-c", command];
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";

    const proc = spawn(shell, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });

    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    // Write payload to stdin
    try {
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
    } catch {
      // stdin may already be closed
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        logger.warn(`Hook "${command}" timed out after ${timeoutMs}ms`);
        resolve(null);
      }
    }, timeoutMs);

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve(stdout.trim());
      } else if (code === 2) {
        // Exit code 2 = deny/abort — return stdout as the reason
        resolve(stdout.trim() || "Hook denied execution");
      } else {
        if (stderr.trim()) {
          logger.warn(`Hook "${command}" exited ${code}: ${stderr.slice(0, 200)}`);
        }
        resolve(null);
      }
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logger.warn(`Hook "${command}" failed to spawn: ${err.message}`);
      resolve(null);
    });
  });
}
