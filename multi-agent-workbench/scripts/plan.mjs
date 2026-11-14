// `maw plan`: turn a plan (a markdown file or a one-line goal) into micro-tasks assigned to agents.
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { agentRegistry } from "./agents.mjs";
import { parsePlan } from "./tasks.mjs";
import { findRepoRoot } from "./git.mjs";

const DEFAULT_PLAN_FILES = ["PLAN.md", "plan.md", "docs/PLAN.md"];
const STRENGTHS = {
  claude: "backend, data models, refactors, tricky logic",
  codex: "frontend, UI, integration and glue code",
  agy: "QA, review, tests and fixing clear bugs",
};

export async function planTasks({ cwd = process.cwd(), input = null, taskPath = "tasks.json", agents = null, planner = null, force = false, quiet = false } = {}) {
  const root = findRepoRoot(cwd);
  if (!root) throw new Error(`${cwd} is not inside a git repository.`);
  const target = resolve(cwd, taskPath);
  if (existsSync(target) && !force) throw new Error(`${target} already exists. Use \`maw plan --force\` to replace it.`);

  // The plan: a file the user wrote, an inline goal, or PLAN.md by default.
  let text;
  let source = null;
  const candidate = input ? resolve(cwd, input) : DEFAULT_PLAN_FILES.map(f => resolve(cwd, f)).find(existsSync);
  if (candidate && existsSync(candidate)) {
    text = await readFile(candidate, "utf8");
    source = relative(root, candidate) || candidate;
  } else if (input && /\.(md|markdown|txt)$/i.test(input)) {
    throw new Error(`Plan file ${input} not found.`);
  } else if (input) {
    text = input;
  } else {
    throw new Error("No plan given. Write your plan in PLAN.md (or pass a file), or run `maw plan \"<goal>\"`.");
  }
  if (!text.trim()) throw new Error("The plan is empty.");

  const registry = agentRegistry();
  const available = agents?.length ? agents : Object.keys(registry).filter(k => installed(registry[k].bin()));
  for (const a of available) if (!registry[a]) throw new Error(`Unknown agent "${a}" in --agents (use ${Object.keys(registry).join(", ")}).`);
  if (!available.length) throw new Error("No agent CLIs found on PATH. Install claude, codex or agy, or pass --agents.");
  const plannerKey = planner || (available.includes("claude") ? "claude" : available[0]);
  const def = registry[plannerKey];
  if (!def) throw new Error(`Unknown planner "${plannerKey}".`);

  let prompt = buildPrompt(text, available, source);
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!quiet) console.log(`maw: ${attempt === 1 ? "planning" : "fixing the plan"} with ${def.label} (assigning to ${available.join(", ")})…`);
    const out = await capture(def.bin(), def.planArgs(prompt), root);
    if (out.error) throw new Error(`${def.label} failed while planning: ${out.error}`);
    try {
      const data = extractJson(out.stdout);
      data.plan = { title: data.plan?.title || firstHeading(text) || "Plan", summary: data.plan?.summary || "", ...(source ? { source } : {}) };
      const { tasks } = parsePlan(data, root, "the generated plan");
      const ordered = { plan: data.plan, ...(data.max_parallel ? { max_parallel: data.max_parallel } : {}), tasks: data.tasks };
      await writeFile(target, JSON.stringify(ordered, null, 2) + "\n");
      return { path: target, plan: data.plan, tasks };
    } catch (error) {
      lastError = error;
      prompt = `${buildPrompt(text, available, source)}\n\nYour previous answer was rejected:\n${error.message}\n\nReturn a corrected JSON object only.`;
    }
  }
  throw new Error(`could not produce a valid task list: ${lastError.message}`);
}

function buildPrompt(plan, agents, source) {
  return `You are the planner for multi-agent-workbench (maw). Read the plan below and the repository in the current directory, then split the work into small micro-tasks for parallel coding agents.

Available agents (use these exact names as "owner"): ${agents.map(a => `${a}${STRENGTHS[a] ? ` (good at ${STRENGTHS[a]})` : ""}`).join("; ")}.

Rules:
- Each task has one clear outcome, touches a handful of files, and fits in one agent run (under an hour).
- Tasks with the same owner run in order on branch maw/<owner>; different owners run in parallel on their own branches.
- Avoid two owners editing the same files. When a task needs another owner's work, add "depends_on" and say in the prompt which branch to merge first (for example "Merge branch maw/claude first.").
- Every "prompt" is self-contained and ends with: "Run the relevant tests and commit your changes with a clear message."
- Add a "check" shell command that proves the task works whenever the repository has a way to test it (for example "npm test -- orders"). Leave it out if unsure.
- Use "retries": 1 for tasks with a check.
- Prefer a final QA/integration task that depends on the others.
- Ids are short: L1, L2 for claude, C1 for codex, A1 for agy, or similar.

Respond with ONLY a JSON object, no prose, in this shape:
{"plan":{"title":"short title","summary":"2-3 sentences on the approach"},"tasks":[{"id":"L1","owner":"claude","task":"short title","prompt":"...","check":"...","retries":1,"depends_on":[]}]}

The plan${source ? ` (from ${source})` : ""}:
<<<PLAN
${plan.trim()}
PLAN>>>`;
}

/** Pull the JSON object out of an agent's answer (bare, or inside a ```json fence). */
export function extractJson(text) {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  const candidates = [...fenced.reverse(), text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object") return Array.isArray(v) ? { tasks: v } : v;
    } catch {}
  }
  throw new Error("the planner did not return a JSON task list");
}

function firstHeading(text) {
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim() || null;
}

function installed(bin) {
  const r = spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 10_000 });
  return !r.error;
}

function capture(cmd, args, cwd) {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      return done({ error: error.message });
    }
    const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (error) => { clearTimeout(timer); done({ error: error.code === "ENOENT" ? `${cmd} is not installed or not on PATH` : error.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? { stdout } : { error: `exit ${code}: ${stderr.trim().split("\n").slice(-3).join(" ")}` });
    });
  });
}
