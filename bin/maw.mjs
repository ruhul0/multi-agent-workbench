#!/usr/bin/env node
import { writeFile, readFile, cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { runWorkbench, findRepoRoot } from "../multi-agent-workbench/scripts/supervisor.mjs";
import { doctor } from "../multi-agent-workbench/scripts/doctor.mjs";
import { dashboard, openBrowser } from "../multi-agent-workbench/scripts/dashboard.mjs";
import { planTasks } from "../multi-agent-workbench/scripts/plan.mjs";
import { review, merge, clean } from "../multi-agent-workbench/scripts/review.mjs";

const HELP = `multi-agent-workbench (maw) — plan work, split it into micro-tasks, and run Claude Code,
Codex, Antigravity (or any agent CLI) in parallel git worktrees with a live dashboard

Usage:
  maw plan [PLAN.md | "goal"]  Split a plan into micro-tasks assigned to agents (writes tasks.json)
                               --agents claude,codex  limit who gets work   --planner <agent>
  maw init [--force]           Create a starter tasks.json by hand instead
  maw doctor [--json]          Check that the agents used in tasks.json are installed and logged in
  maw run                      Run the task queue (default command) and open the live dashboard
                               --dry-run       validate and print the plan
                               --resume        keep tasks already done in the previous run
                               --max-parallel  limit how many tasks run at once
                               --notify        desktop notification when the run ends
                               --no-open       serve the dashboard without opening a browser
                               --no-dashboard  skip the dashboard entirely
  maw status                   Print the latest run as a summary
  maw review [--json]          Show each task's commits, changes and check results
  maw merge                    Merge finished work into a maw/integration worktree
                               --into-current  merge into your checked-out branch instead
                               --only L1,C1    merge only these tasks   --check "<cmd>"  test the result
  maw clean                    Remove maw's worktrees (--branches also deletes branches, --force discards changes)
  maw dashboard [--port N]     Serve the dashboard for the latest run on http://127.0.0.1:4317
  maw install-skill            Install the planning skill for Codex and Claude Code
                               (--codex or --claude to pick one)

Options:
  --tasks <file>               Use a different task file (default: tasks.json)
  --port <n>                   Dashboard port (default 4317; the next free port is used if taken)
  -h, --help                   Show this help
  -v, --version                Show the version

Agents run with permission prompts disabled inside their worktrees. Review every commit before merging.`;

// Strict parsing: a mistyped flag (e.g. --dryrun) must fail instead of starting a real run.
let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      force: { type: "boolean" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      resume: { type: "boolean" },
      notify: { type: "boolean" },
      "no-open": { type: "boolean" },
      "no-dashboard": { type: "boolean" },
      codex: { type: "boolean" },
      claude: { type: "boolean" },
      branches: { type: "boolean" },
      "into-current": { type: "boolean" },
      tasks: { type: "string" },
      port: { type: "string" },
      "max-parallel": { type: "string" },
      agents: { type: "string" },
      planner: { type: "string" },
      only: { type: "string" },
      check: { type: "string" },
    },
  });
} catch (error) {
  console.error(`maw: ${error.message.split(". To specify")[0]}\nRun \`maw --help\` for usage.`);
  process.exit(2);
}
const flag = (name) => args.values[name] === true;
const value = (name) => args.values[name];
const command = args.positionals[0] || "run";
const taskPath = value("tasks");
const list = (name) => value(name)?.split(",").map(s => s.trim()).filter(Boolean) || null;
// State lives at the repository root so `maw status` and the dashboard work from any subdirectory.
const stateRoot = () => findRepoRoot(process.cwd()) || process.cwd();

async function main() {
  if (flag("help") || command === "help") { console.log(HELP); return 0; }
  if (flag("version")) {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    return 0;
  }
  switch (command) {
    case "init": return init();
    case "plan": return plan();
    case "doctor": return (await doctor({ taskPath, json: flag("json") })) ? 0 : 1;
    case "run": return run();
    case "status": return status();
    case "review": return (await review({ json: flag("json") })) ? 0 : 1;
    case "merge": {
      const r = await merge({ only: list("only"), intoCurrent: flag("into-current"), check: value("check") || null });
      return r.ok ? 0 : 1;
    }
    case "clean": return (await clean({ taskPath, branches: flag("branches"), force: flag("force") })) ? 0 : 1;
    case "install-skill": return installSkill();
    case "dashboard": {
      const { url } = await dashboard({ root: stateRoot(), port: dashboardPort() });
      console.log(`maw dashboard: ${url}  (Ctrl+C to stop)`);
      if (!flag("no-open")) openBrowser(url);
      return null; // keep the server running
    }
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

function dashboardPort() {
  const port = Number(value("port") || 4317);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("--port must be a valid port number");
  return port;
}

async function plan() {
  const input = args.positionals.slice(1).join(" ") || null;
  const { path, plan: p, tasks } = await planTasks({ input, taskPath: taskPath || "tasks.json", agents: list("agents"), planner: value("planner"), force: flag("force") });
  console.log(`\nWrote ${path}${p.title ? ` — ${p.title}` : ""}`);
  for (const t of tasks) console.log(`  ${t.id.padEnd(6)} ${t.owner.padEnd(12)} ${t.task}${t.depends_on.length ? `  (after ${t.depends_on.join(", ")})` : ""}`);
  console.log("\nReview and edit the prompts, then run `maw run --dry-run` and `maw`.");
  return 0;
}

async function run() {
  const dryRun = flag("dry-run");
  let maxParallel = null;
  if (value("max-parallel") != null) {
    maxParallel = Number(value("max-parallel"));
    if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("--max-parallel must be a whole number of at least 1");
  }
  const wantDashboard = !dryRun && !flag("no-dashboard") && !process.env.MAW_NO_DASHBOARD;
  const control = {};
  let server = null;
  if (wantDashboard) {
    try {
      const d = await dashboard({ root: stateRoot(), port: dashboardPort(), control });
      server = d.server;
      console.log(`maw: live dashboard at ${d.url}`);
      if (!flag("no-open") && !process.env.CI) openBrowser(d.url);
    } catch (error) {
      console.error(`maw: dashboard unavailable (${error.message}); continuing without it`);
    }
  }
  let code;
  try {
    const { ok } = await runWorkbench({ taskPath, dryRun, resume: flag("resume"), maxParallel, notifyDesktop: flag("notify"), control });
    code = process.exitCode === 130 ? 130 : ok ? 0 : 1;
  } catch (error) {
    server?.close();
    throw error;
  }
  if (!server) return code;
  // Keep the dashboard up for review when a person is watching; exit right away in scripts.
  if (!process.stdin.isTTY || code === 130) { server.close(); return code; }
  console.log("maw: run finished. Dashboard stays open for review; press Ctrl+C to exit. Next: `maw review`, then `maw merge`.");
  process.once("SIGINT", () => { server.close(); process.exit(code); });
  return null;
}

async function init() {
  const target = resolve(process.cwd(), taskPath || "tasks.json");
  if (existsSync(target) && !flag("force")) {
    console.error(`${target} already exists. Edit it, or run \`maw init --force\` to overwrite it.`);
    return 1;
  }
  const starter = {
    $schema: "https://unpkg.com/multi-agent-workbench/tasks.schema.json",
    plan: { title: "Describe the goal here", summary: "One or two sentences on the approach." },
    tasks: [
      { id: "L1", owner: "claude", task: "Backend task", prompt: "Implement the backend task, run its tests, and commit the result.", retries: 1 },
      { id: "C1", owner: "codex", task: "Frontend task", prompt: "Implement the frontend task, run its tests, and commit the result.", retries: 1 },
      { id: "A1", owner: "antigravity", command: "agy", task: "QA task", depends_on: ["L1", "C1"], prompt: "Merge branches maw/claude and maw/codex into this branch, review the changes, fix only clear issues, run all tests, and commit." },
    ],
  };
  await writeFile(target, JSON.stringify(starter, null, 2) + "\n");
  console.log(`Created ${target}.\nEdit the prompts (or generate them from a plan with \`maw plan PLAN.md --force\`), then run \`maw doctor\` and \`maw\`.`);
  return 0;
}

async function installSkill() {
  const source = fileURLToPath(new URL("../multi-agent-workbench", import.meta.url));
  const targets = [];
  if (!flag("claude")) targets.push(resolve(homedir(), ".codex/skills/multi-agent-workbench"));
  if (!flag("codex")) targets.push(resolve(homedir(), ".claude/skills/multi-agent-workbench"));
  for (const target of targets) {
    await mkdir(resolve(target, ".."), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
    console.log(`Installed skill to ${target}`);
  }
  console.log("Invoke it with $multi-agent-workbench in Codex or /multi-agent-workbench in Claude Code.");
  return 0;
}

async function status() {
  const path = resolve(stateRoot(), ".agent-workbench/status.json");
  let s;
  try { s = JSON.parse(await readFile(path, "utf8")); } catch {
    console.error("No status yet. Run `maw` in this project first.");
    return 1;
  }
  if (s.plan?.title) console.log(`Plan: ${s.plan.title}`);
  console.log(`${s.finished ? "Finished" : "Running"} · updated ${s.updated_at}${s.usage?.cost_usd ? ` · $${s.usage.cost_usd.toFixed(2)}` : ""}`);
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
