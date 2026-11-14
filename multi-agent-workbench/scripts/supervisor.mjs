#!/usr/bin/env node
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";

const root = process.env.WORKBENCH_ROOT || process.cwd();
const dir = `${root}/.agent-workbench`;
await mkdir(dir, { recursive: true });
const taskPath = process.env.WORKBENCH_TASKS || `${root}/tasks.json`;
let tasks;
try {
  tasks = JSON.parse(await readFile(taskPath, "utf8"));
} catch (error) {
  console.error(`No tasks.json found at ${taskPath}. Create a task queue first; see the README example.`);
  process.exitCode = 2;
  process.exit();
}
if (!Array.isArray(tasks) || tasks.length === 0) {
  console.error(`No tasks found in ${taskPath}. Add at least one Claude or Codex task.`);
  process.exitCode = 2;
  process.exit();
}
const statePath = `${dir}/status.json`, logPath = `${dir}/supervisor.log`;
const state = { agents: {}, history: [], recent: [] };
const save = () => writeFile(statePath, JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2));
const log = async (line) => { const s = `[${new Date().toISOString()}] ${line}`; state.recent = [...state.recent, s].slice(-40); await appendFile(logPath, s + "\n"); await save(); };
function run(cmd, args, cwd) { return new Promise(resolve => { const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); let out = ""; p.stdout.on("data", x => { out += x; process.stdout.write(x); }); p.stderr.on("data", x => { out += x; process.stderr.write(x); }); p.on("close", code => resolve({ code: code ?? 1, out })); }); }
async function execute(task) {
  state.agents[task.owner] = { state: "working", task: task.task, commit: null, output: [] }; await log(`${task.owner} start ${task.id}`);
  const command = task.command || task.owner;
  const args = command === "claude" ? ["--model", process.env.CLAUDE_MODEL || "haiku", "--effort", "low", "-p", task.prompt, "--dangerously-skip-permissions"] : command === "agy" || command === "antigravity" ? ["--dangerously-skip-permissions", "--print", task.prompt] : ["exec", "-m", process.env.CODEX_MODEL || "gpt-6.1-sol", "-s", "danger-full-access", "--dangerously-bypass-approvals-and-sandbox", task.prompt];
  const r = await run(command === "claude" ? "claude" : command === "agy" || command === "antigravity" ? "agy" : "codex", args, task.worktree);
  const commit = (r.out.match(/\b[0-9a-f]{7,40}\b/g) || []).at(-1) || null;
  state.agents[task.owner] = { state: r.code === 0 ? "done" : "blocked", task: task.task, commit, output: r.out.split("\n").slice(-30) };
  state.history = [...state.history, { id: task.id, owner: task.owner, task: task.task, commit, state: state.agents[task.owner].state, output: state.agents[task.owner].output, finished_at: new Date().toISOString() }].slice(-40);
  await log(`${task.owner} ${state.agents[task.owner].state} ${task.id} ${commit || "—"}`); return r.code === 0;
}
await Promise.all(Object.entries(Object.groupBy(tasks, t => t.owner)).map(async ([, queue]) => { for (const task of queue) if (!await execute(task)) break; }));
