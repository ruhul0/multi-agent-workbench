#!/usr/bin/env node
import { writeFile, readFile, cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { runWorkbench } from "../multi-agent-workbench/scripts/supervisor.mjs";
import { doctor } from "../multi-agent-workbench/scripts/doctor.mjs";
import { dashboard } from "../multi-agent-workbench/scripts/dashboard.mjs";

const HELP = `multi-agent-workbench (maw) — run Claude Code, Codex and Antigravity tasks in parallel git worktrees

Usage:
  maw init [--force]       Create a starter tasks.json in the current project
  maw doctor               Check that the agents used in tasks.json are installed and logged in
  maw run [--dry-run]      Run the task queue (default command). --dry-run validates and prints the plan
  maw status               Print the latest .agent-workbench/status.json as a summary
  maw dashboard [--port N] Serve a live status page on http://127.0.0.1:4317
  maw install-skill        Install the planning skill for Codex and Claude Code
                           (--codex or --claude to pick one)

Options:
  --tasks <file>           Use a different task file (default: tasks.json)
  -h, --help               Show this help
  -v, --version            Show the version

Agents run with permission prompts disabled inside their worktrees. Review every commit before merging.`;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const command = argv.find((a, i) => !a.startsWith("-") && !["--tasks", "--port"].includes(argv[i - 1])) || "run";
const taskPath = value("--tasks");

async function main() {
  if (flag("-h") || flag("--help") || command === "help") { console.log(HELP); return 0; }
  if (flag("-v") || flag("--version")) {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    return 0;
  }
  switch (command) {
    case "init": return init();
    case "doctor": return (await doctor({ taskPath })) ? 0 : 1;
    case "run": {
      const { ok } = await runWorkbench({ taskPath, dryRun: flag("--dry-run") });
      return process.exitCode === 130 ? 130 : ok ? 0 : 1;
    }
    case "status": return status();
    case "install-skill": return installSkill();
    case "dashboard": {
      const port = Number(value("--port") || 4317);
      if (!Number.isInteger(port) || port <= 0) throw new Error("--port must be a positive integer");
      dashboard({ port });
      return null; // keep the server running
    }
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

async function init() {
  const target = resolve(process.cwd(), taskPath || "tasks.json");
  if (existsSync(target) && !flag("--force")) {
    console.error(`${target} already exists. Edit it, or run \`maw init --force\` to overwrite it.`);
    return 1;
  }
  const tasks = [
    { id: "L1", owner: "claude", command: "claude", task: "Backend task", prompt: "Implement the backend task, run its tests, and commit the result." },
    { id: "C1", owner: "codex", command: "codex", task: "Frontend task", prompt: "Implement the frontend task, run its tests, and commit the result." },
    { id: "A1", owner: "antigravity", command: "agy", task: "QA task", depends_on: ["L1", "C1"], prompt: "Review the latest changes on this branch, fix only clear issues, and commit them." },
  ];
  await writeFile(target, JSON.stringify(tasks, null, 2) + "\n");
  console.log(`Created ${target}.\nEdit the prompts, then run \`maw doctor\` and \`maw\`.`);
  return 0;
}

async function installSkill() {
  const source = fileURLToPath(new URL("../multi-agent-workbench", import.meta.url));
  const targets = [];
  if (!flag("--claude")) targets.push(resolve(homedir(), ".codex/skills/multi-agent-workbench"));
  if (!flag("--codex")) targets.push(resolve(homedir(), ".claude/skills/multi-agent-workbench"));
  for (const target of targets) {
    await mkdir(resolve(target, ".."), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
    console.log(`Installed skill to ${target}`);
  }
  console.log("Invoke it with $multi-agent-workbench in Codex or /multi-agent-workbench in Claude Code.");
  return 0;
}

async function status() {
  const path = resolve(process.cwd(), ".agent-workbench/status.json");
  let s;
  try { s = JSON.parse(await readFile(path, "utf8")); } catch {
    console.error("No status yet. Run `maw` in this project first.");
    return 1;
  }
  console.log(`${s.finished ? "Finished" : "Running"} · updated ${s.updated_at}`);
  for (const t of s.tasks || []) {
    console.log(`${t.state.padEnd(8)} ${t.id.padEnd(8)} ${t.owner.padEnd(12)} ${(t.commit || "—").padEnd(12)} ${t.task}${t.reason ? `  (${t.reason})` : ""}`);
  }
  return 0;
}

try {
  const code = await main();
  if (code !== null) process.exitCode = code;
} catch (error) {
  console.error(`maw: ${error.message}`);
  process.exitCode = 2;
}
