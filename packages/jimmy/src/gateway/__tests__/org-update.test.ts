import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

let tmpDir: string;

vi.mock("../../shared/paths.js", () => ({
  get ORG_DIR() {
    return tmpDir;
  },
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { updateEmployeeYaml } from "../org.js";

function writeYaml(subdir: string, filename: string, content: string) {
  const dir = path.join(tmpDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

function readYaml(subdir: string, filename: string): any {
  return yaml.load(fs.readFileSync(path.join(tmpDir, subdir, filename), "utf-8"));
}

describe("updateEmployeeYaml", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-update-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates alwaysNotify field in existing YAML", () => {
    writeYaml("platform", "dev.yaml", `
name: dev
persona: A developer
rank: senior
`);
    const result = updateEmployeeYaml("dev", { alwaysNotify: false });
    expect(result).toBe(true);

    const data = readYaml("platform", "dev.yaml");
    expect(data.alwaysNotify).toBe(false);
    expect(data.name).toBe("dev");
    expect(data.persona).toBe("A developer");
    expect(data.rank).toBe("senior");
  });

  it("sets alwaysNotify to true", () => {
    writeYaml("platform", "worker.yaml", `
name: worker
persona: A worker
alwaysNotify: false
`);
    const result = updateEmployeeYaml("worker", { alwaysNotify: true });
    expect(result).toBe(true);

    const data = readYaml("platform", "worker.yaml");
    expect(data.alwaysNotify).toBe(true);
  });

  it("returns false for non-existent employee", () => {
    const result = updateEmployeeYaml("ghost", { alwaysNotify: false });
    expect(result).toBe(false);
  });

  it("preserves all other YAML fields", () => {
    writeYaml("homy", "lead.yaml", `
name: homy-lead
displayName: Homy Lead
department: homy
rank: manager
engine: claude
model: opus
persona: The homy lead
emoji: "🏠"
`);
    updateEmployeeYaml("homy-lead", { alwaysNotify: false });

    const data = readYaml("homy", "lead.yaml");
    expect(data.displayName).toBe("Homy Lead");
    expect(data.department).toBe("homy");
    expect(data.rank).toBe("manager");
    expect(data.engine).toBe("claude");
    expect(data.model).toBe("opus");
    expect(data.emoji).toBe("🏠");
    expect(data.alwaysNotify).toBe(false);
  });

  it("only allows updating alwaysNotify (ignores other fields)", () => {
    writeYaml("platform", "safe.yaml", `
name: safe
persona: Original persona
rank: employee
`);
    // Try to sneak in a rank change — should be ignored
    updateEmployeeYaml("safe", { alwaysNotify: false } as any);

    const data = readYaml("platform", "safe.yaml");
    expect(data.rank).toBe("employee");
    expect(data.persona).toBe("Original persona");
  });
});
