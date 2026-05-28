import fs from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { CONFIG_PATH, CRON_JOBS, ORG_DIR, SKILLS_DIR, CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { parseSkillFrontmatter } from "../skills/validator.js";

/**
 * Read a skill's `hidden: true` flag from its SKILL.md frontmatter.
 * Returns false on any failure — missing file, malformed YAML, no flag.
 * Hiding is opt-in; we never hide by accident.
 */
function isSkillHidden(skillName: string): boolean {
  const skillMd = path.join(SKILLS_DIR, skillName, "SKILL.md");
  let content: string;
  try {
    content = fs.readFileSync(skillMd, "utf-8");
  } catch {
    return false;
  }
  const fm = parseSkillFrontmatter(content);
  return fm?.hidden === true;
}

export interface WatcherCallbacks {
  onConfigReload: () => void;
  onCronReload: () => void;
  onOrgChange: () => void;
  onSkillsChange: () => void;
}

let watchers: FSWatcher[] = [];

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/**
 * Sync symlinks in .claude/skills/ and .agents/skills/ to match skills/.
 * Each skill directory gets a relative symlink: ../../skills/<name>
 */
export function syncSkillSymlinks(): void {
  const targetDirs = [CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR];

  // Get current skill directories
  let skillNames: string[] = [];
  if (fs.existsSync(SKILLS_DIR)) {
    skillNames = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  }

  // Skills with `hidden: true` frontmatter are excluded from the engine
  // catalog. They're still on disk and readable by exact name; we just
  // don't symlink them so Claude/Codex don't surface them in their
  // skill listings.
  const visibleNames = skillNames.filter((name) => !isSkillHidden(name));
  const visibleSet = new Set(visibleNames);

  for (const targetDir of targetDirs) {
    fs.mkdirSync(targetDir, { recursive: true });

    // Remove stale symlinks — including ones for skills that are now hidden
    // or whose source directory was deleted.
    const existing = fs.readdirSync(targetDir, { withFileTypes: true });
    for (const entry of existing) {
      if (!visibleSet.has(entry.name)) {
        const linkPath = path.join(targetDir, entry.name);
        try {
          fs.unlinkSync(linkPath);
          logger.debug(`Removed stale skill symlink: ${linkPath}`);
        } catch {
          // ignore
        }
      }
    }

    // Create missing symlinks (with copy fallback for Windows without Developer Mode)
    for (const name of visibleNames) {
      const linkPath = path.join(targetDir, name);
      const relTarget = path.join("..", "..", "skills", name);
      const absTarget = path.join(SKILLS_DIR, name);
      if (!fs.existsSync(linkPath)) {
        try {
          fs.symlinkSync(relTarget, linkPath);
          logger.debug(`Created skill symlink: ${linkPath} -> ${relTarget}`);
        } catch {
          try {
            fs.cpSync(absTarget, linkPath, { recursive: true });
            logger.debug(`Copied skill (symlink unavailable): ${linkPath}`);
          } catch {
            // ignore — skill won't be discoverable from this path
          }
        }
      }
    }
  }
}

/**
 * Resilient single-file watcher.
 *
 * Watches the *parent directory* filtered to a single file (depth 0).
 * Why: atomic-rename writes (vim, git checkout, many editors) unlink the
 * original inode and create a new one. A direct file watch's underlying
 * fs handle becomes invalid in that case and chokidar silently stops
 * emitting events — which was the root cause of nyem69/jinn#15. A
 * directory watch persists across inode replacements, and listening for
 * both `change` and `add` catches in-place edits *and* atomic replaces.
 */
function watchSingleFile(
  filePath: string,
  label: string,
  callback: () => void,
  debounceMs: number,
): FSWatcher {
  const dir = path.dirname(filePath);
  const file = path.basename(filePath);
  const w = watch(dir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300 },
    depth: 0,
    ignored: (p) => {
      // The watched directory itself must not be ignored.
      if (path.resolve(p) === path.resolve(dir)) return false;
      return path.basename(p) !== file;
    },
  });
  const fire = debounce(() => {
    logger.info(`${label} changed, reloading...`);
    try {
      callback();
    } catch (err) {
      logger.warn(`${label} reload callback failed: ${(err as Error).message ?? err}`);
    }
  }, debounceMs);
  w.on("change", fire);
  w.on("add", fire); // atomic replace lands here, not "change"
  w.on("error", (err) => {
    logger.warn(`${label} watcher error: ${(err as Error).message ?? err}`);
  });
  return w;
}

export function startWatchers(callbacks: WatcherCallbacks): void {
  const DEBOUNCE_MS = 500;

  const configWatcher = watchSingleFile(
    CONFIG_PATH,
    "config.yaml",
    callbacks.onConfigReload,
    DEBOUNCE_MS,
  );

  const cronWatcher = watchSingleFile(
    CRON_JOBS,
    "cron/jobs.json",
    callbacks.onCronReload,
    DEBOUNCE_MS,
  );

  const orgWatcher = watch(ORG_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300 },
  });
  orgWatcher.on(
    "all",
    debounce(() => {
      logger.info("org/ directory changed, reloading...");
      callbacks.onOrgChange();
    }, DEBOUNCE_MS),
  );

  // Watch skills/ directory for added/removed skill folders → sync symlinks.
  // Depth 2 so toggling `hidden:` in `skills/<name>/SKILL.md` also re-syncs.
  const skillsWatcher = watch(SKILLS_DIR, {
    ignoreInitial: true,
    depth: 2,
  });
  skillsWatcher.on(
    "all",
    debounce(() => {
      logger.info("skills/ directory changed, syncing symlinks...");
      syncSkillSymlinks();
      callbacks.onSkillsChange();
    }, DEBOUNCE_MS),
  );

  watchers = [configWatcher, cronWatcher, orgWatcher, skillsWatcher];
  logger.info("File watchers started");
}

export async function stopWatchers(): Promise<void> {
  await Promise.all(watchers.map((w) => w.close()));
  watchers = [];
  logger.info("File watchers stopped");
}
