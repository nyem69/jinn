import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { SKILLS_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  dependencies?: string[];
  // Other fields are tolerated but not validated here.
  [key: string]: unknown;
}

export interface SkillSummary {
  name: string;
  description: string;
  dependencies: string[];
  missingDependencies: string[];
}

/**
 * Parse the YAML frontmatter of a SKILL.md file. Returns null if the file
 * doesn't have valid frontmatter — callers should fall back to other
 * extraction strategies.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    const data = yaml.load(match[1]);
    if (data && typeof data === "object") {
      return data as SkillFrontmatter;
    }
  } catch {
    // Malformed YAML — treat as no frontmatter
  }
  return null;
}

/**
 * Scan the skills directory and return a summary for each skill, including
 * declared dependencies and which of them are missing from the directory.
 *
 * A skill is "missing" if `dependencies: [foo]` is declared in its
 * frontmatter but `~/.jinn/skills/foo/SKILL.md` doesn't exist.
 */
export function scanSkills(): SkillSummary[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];

  const dirents = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skillFolders = dirents
    .filter((e) => {
      // Follow symlinks — Dirent.isDirectory() returns false for symlinks
      // even when the target is a directory. The dbp-translator-claude
      // skill is symlinked from /Users/azmi/PROJECTS/LLM/dbp-translator-claude
      // and similar future installs may use the same pattern.
      if (e.isDirectory()) return true;
      if (e.isSymbolicLink()) {
        try {
          return fs.statSync(path.join(SKILLS_DIR, e.name)).isDirectory();
        } catch {
          return false;
        }
      }
      return false;
    })
    .map((e) => e.name);
  const present = new Set(skillFolders);

  const out: SkillSummary[] = [];
  for (const name of skillFolders) {
    const skillMd = path.join(SKILLS_DIR, name, "SKILL.md");
    let description = "";
    let dependencies: string[] = [];

    if (fs.existsSync(skillMd)) {
      const content = fs.readFileSync(skillMd, "utf-8");
      const fm = parseSkillFrontmatter(content);
      if (fm) {
        if (typeof fm.description === "string") description = fm.description.trim();
        if (Array.isArray(fm.dependencies)) {
          dependencies = fm.dependencies
            .filter((d): d is string => typeof d === "string" && d.length > 0)
            .map((d) => d.trim());
        }
      }
      // Description fallback: ## Trigger heading or first non-heading paragraph
      if (!description) {
        const triggerMatch = content.match(/##\s*Trigger\s*\n+([^\n#]+)/);
        if (triggerMatch) {
          description = triggerMatch[1].trim();
        } else {
          const fmMatch = content.match(/^---\s*\n[\s\S]*?\n---/);
          const body = fmMatch ? content.slice(fmMatch[0].length) : content;
          for (const line of body.split("\n")) {
            const t = line.trim();
            if (t && !t.startsWith("#")) {
              description = t;
              break;
            }
          }
        }
      }
    }

    const missingDependencies = dependencies.filter((d) => !present.has(d));
    out.push({ name, description, dependencies, missingDependencies });
  }

  return out;
}

/**
 * Log warnings for skills with unresolved dependencies. Called once at
 * gateway boot and after skills/ directory changes (via the file watcher).
 *
 * Returns the count of broken dependency edges (skill × missing dep) so
 * callers can include the metric in startup banners or health reports.
 */
export function warnOnMissingSkillDependencies(skills?: SkillSummary[]): number {
  const summaries = skills ?? scanSkills();
  let brokenEdges = 0;
  const broken: Array<{ skill: string; missing: string[] }> = [];
  for (const s of summaries) {
    if (s.missingDependencies.length > 0) {
      broken.push({ skill: s.name, missing: s.missingDependencies });
      brokenEdges += s.missingDependencies.length;
    }
  }
  if (broken.length > 0) {
    logger.warn(
      `Skill dependency check: ${broken.length} skill(s) reference ${brokenEdges} missing dependencies.`,
    );
    for (const b of broken) {
      logger.warn(`  ${b.skill} → missing: ${b.missing.join(", ")}`);
    }
  }
  return brokenEdges;
}
