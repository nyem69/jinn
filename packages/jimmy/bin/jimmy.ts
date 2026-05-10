#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import os from "node:os";
import pkg from "../package.json" with { type: "json" };

const program = new Command();
program
  .name("jinn")
  .description("Lightweight AI gateway daemon")
  .version(pkg.version)
  .option("-i, --instance <name>", "Target a specific instance (default: jinn)");

// Pre-parse to set JINN_HOME before any module imports resolve paths
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.opts();
  if (opts.instance) {
    process.env.JINN_INSTANCE = opts.instance;
    process.env.JINN_HOME = path.join(os.homedir(), `.${opts.instance}`);
  }
});

program
  .command("setup")
  .description("Initialize Jinn and install dependencies")
  .option("--force", "Delete existing home dir and reinitialize from scratch")
  .action(async (opts) => {
    const { runSetup } = await import("../src/cli/setup.js");
    await runSetup(opts);
  });

program
  .command("start")
  .description("Start the gateway daemon")
  .option("--daemon", "Run in background")
  .option("-p, --port <port>", "Override the gateway port from config")
  .action(async (opts) => {
    const { runStart } = await import("../src/cli/start.js");
    await runStart({ daemon: opts.daemon, port: opts.port ? parseInt(opts.port, 10) : undefined });
  });

program
  .command("stop")
  .description("Stop the gateway daemon")
  .option("-p, --port <port>", "Port to kill the process on (default: from config or 7777)")
  .action(async (opts: { port?: string }) => {
    const { runStop } = await import("../src/cli/stop.js");
    await runStop(opts.port ? parseInt(opts.port, 10) : undefined);
  });

program
  .command("status")
  .description("Show gateway status")
  .action(async () => {
    const { runStatus } = await import("../src/cli/status.js");
    await runStatus();
  });

program
  .command("create <name>")
  .description("Create a new Jinn instance")
  .option("-p, --port <port>", "Set gateway port (auto-assigned if omitted)")
  .action(async (name: string, opts: { port?: string }) => {
    const { runCreate } = await import("../src/cli/create.js");
    await runCreate(name, opts.port ? parseInt(opts.port, 10) : undefined);
  });

program
  .command("list")
  .description("List all Jinn instances")
  .action(async () => {
    const { runList } = await import("../src/cli/list.js");
    await runList();
  });

program
  .command("remove <name>")
  .description("Remove a Jinn instance from the registry")
  .option("--force", "Also delete the instance home directory")
  .action(async (name: string, opts: { force?: boolean }) => {
    const { runRemove } = await import("../src/cli/remove.js");
    await runRemove(name, opts);
  });

program
  .command("nuke [name]")
  .description("Permanently delete a Jinn instance and all its data")
  .action(async (name?: string) => {
    const { runNuke } = await import("../src/cli/nuke.js");
    await runNuke(name);
  });

program
  .command("migrate")
  .description("Apply pending template migrations to update this instance")
  .option("--check", "Only check for pending migrations, don't apply")
  .option("--auto", "Apply safe changes automatically without launching AI")
  .action(async (opts) => {
    const { runMigrate } = await import("../src/cli/migrate.js");
    await runMigrate(opts);
  });

// jinn db apply | rollback <version> | status — schema migrations
{
  const dbCmd = program
    .command("db")
    .description("Schema migrations for sessions/registry.db");

  dbCmd
    .command("apply")
    .description("Apply pending schema migrations")
    .action(async () => {
      const { dbApply } = await import("../src/cli/db.js");
      await dbApply();
    });

  dbCmd
    .command("rollback <version>")
    .description("Roll back all migrations newer than <version>. Use __ROLLBACK_ALL__ to revert everything.")
    .action(async (version: string) => {
      const { dbRollback } = await import("../src/cli/db.js");
      await dbRollback({ target: version });
    });

  dbCmd
    .command("status")
    .description("Show applied vs pending schema migrations")
    .action(async () => {
      const { dbStatus } = await import("../src/cli/db.js");
      await dbStatus();
    });
}

// Skills subcommands (jinn skills find|add|remove|list|update|restore)
{
  const skillsCmd = program
    .command("skills")
    .description("Manage skills from the skills.sh registry");

  skillsCmd
    .command("find [query]")
    .description("Search the skills.sh registry")
    .action(async (query?: string) => {
      const { skillsFind } = await import("../src/cli/skills.js");
      skillsFind(query);
    });

  skillsCmd
    .command("add <package>")
    .description("Install a skill from skills.sh")
    .action(async (pkg: string) => {
      const { skillsAdd } = await import("../src/cli/skills.js");
      skillsAdd(pkg);
    });

  skillsCmd
    .command("remove <name>")
    .description("Remove a skill from this instance")
    .action(async (name: string) => {
      const { skillsRemove } = await import("../src/cli/skills.js");
      skillsRemove(name);
    });

  skillsCmd
    .command("list")
    .description("List installed skills")
    .action(async () => {
      const { skillsList } = await import("../src/cli/skills.js");
      skillsList();
    });

  skillsCmd
    .command("update")
    .description("Re-install all skills to get latest versions")
    .action(async () => {
      const { skillsUpdate } = await import("../src/cli/skills.js");
      skillsUpdate();
    });

  skillsCmd
    .command("restore")
    .description("Install all skills listed in skills.json")
    .action(async () => {
      const { skillsRestore } = await import("../src/cli/skills.js");
      skillsRestore();
    });
}

program
  .command("t1a-status")
  .description("T1A soak snapshot: events, DLQ, handlers, cost_log autofill")
  .option("--since <iso>", "Window start (ISO datetime). Default: 24h ago")
  .option("--json", "Emit machine-readable JSON instead of the human report")
  .action(async (opts: { since?: string; json?: boolean }) => {
    const { runT1aStatus } = await import("../src/cli/t1a-status.js");
    await runT1aStatus({ since: opts.since, json: opts.json });
  });

program
  .command("replay <session-id>")
  .description("Print replay context for a session checkpoint (T1A.PR5)")
  .option("--from-step <n>", "Use the checkpoint at step_seq N (default: latest)")
  .option("--branch <name>", "Source branch (default: 'main')")
  .option("--to-branch <name>", "Destination branch name for the fork (default: auto)")
  .option("--edit-prompt <file>", "Splice file contents into checkpoint.state.prompt")
  .option("--print", "Output the full replay context as JSON")
  .action(async (sessionId: string, opts: { fromStep?: string; branch?: string; toBranch?: string; editPrompt?: string; print?: boolean }) => {
    const { runReplay } = await import("../src/cli/replay.js");
    await runReplay({
      sessionId,
      fromStep: opts.fromStep ? parseInt(opts.fromStep, 10) : undefined,
      branch: opts.branch,
      toBranch: opts.toBranch,
      editPrompt: opts.editPrompt,
      print: opts.print,
    });
  });

program
  .command("chrome-allow")
  .description("Pre-approve all sites for the Claude Chrome extension")
  .option("--no-restart", "Don't restart Chrome automatically")
  .option("--comet-browser", "Target Comet browser instead of Google Chrome")
  .action(async (opts) => {
    const { runChromeAllow } = await import("../src/cli/chrome-allow.js");
    await runChromeAllow(opts);
  });

program.parse();
