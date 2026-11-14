#!/usr/bin/env node
// Multi-agent workbench supervisor: runs tasks.json across agent CLIs in isolated git worktrees.
import { mkdir, writeFile, appendFile, rename, stat, realpath } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { AGENTS } from "./agents.mjs";
import { loadTasks } from "./tasks.mjs";

const OUTPUT_TAIL = 30;

export async function runWorkbench({
  root = process.env.WORKBENCH_ROOT || process.cwd(),
  taskPath = process.env.WORKBENCH_TASKS,
  dryRun = false,
  quiet = false,
} = {}) {
  root = resolve(root);
  taskPath = resolve(root, taskPath || "tasks.json");
  const tasks = await loadTasks(taskPath, root);
  const repoRoot = git(root, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot.ok) throw new Error(`${root} is not inside a git repository. Run \`git init\` and make a first commit.`);
  if (!git(root, ["rev-parse", "--verify", "HEAD"]).ok) throw new Error("The repository has no commits yet. Make an initial commit so worktrees can be created.");

  if (dryRun) {
    for (const t of tasks) {
      console.log(`${t.id}  ${t.owner} (${t.agent})  ${t.worktree} [${t.branch}]${t.depends_on.length ? `  after ${t.depends_on.join(", ")}` : ""}${t.check ? `  check: ${t.check}` : ""}`);
    }
    return { ok: true, tasks };
  }

  const dir = resolve(root, ".agent-workbench");
  const logDir = resolve(dir, "logs");
  await mkdir(logDir, { recursive: true });
  const statePath = resolve(dir, "status.json");
  const logPath = resolve(dir, "supervisor.log");

  const state = {
    root,
    started_at: new Date().toISOString(),
    finished: false,
    agents: {},
    tasks: tasks.map(t => ({ id: t.id, owner: t.owner, agent: t.agent, task: t.task, worktree: t.worktree, branch: t.branch, depends_on: t.depends_on, state: "pending", commit: null, commits: [], dirty: false, check: t.check ? { command: t.check, passed: null } : null, exit_code: null, reason: null, started_at: null, finished_at: null, output: [] })),
    recent: [],
  };
  const rec = new Map(state.tasks.map(r => [r.id, r]));

  // Serialized, atomic status writes so parallel agents can't corrupt status.json.
  let writeChain = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2);
    writeChain = writeChain.then(async () => {
      const tmp = `${statePath}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, statePath);
    }).catch(() => {});
    return writeChain;
  };
  // Persist live output at most once a second so the dashboard can follow along.
  let saveTimer = null;
  const saveSoon = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; save(); }, 1000);
    saveTimer.unref?.();
  };
  const log = async (line) => {
    const s = `[${new Date().toISOString()}] ${line}`;
    state.recent = [...state.recent, s].slice(-40);
    if (!quiet) console.log(`maw: ${line}`);
    await appendFile(logPath, s + "\n");
    await save();
  };

  // Create worktrees up front, sequentially (git holds a lock on worktree metadata).
  const prepared = new Map();
  for (const t of tasks) {
    if (prepared.has(t.worktree)) continue;
    const result = await ensureWorktree(root, t);
    prepared.set(t.worktree, result);
    if (!result.ok) await log(`worktree error for ${t.id}: ${result.error}`);
    else if (result.created) await log(`created worktree ${t.worktree} on ${t.branch}`);
  }

  const children = new Set();
  let interrupted = false;
  const onSignal = (signal) => {
    if (interrupted) return;
    interrupted = true;
    for (const c of children) c.kill("SIGTERM");
    log(`received ${signal}; stopping agents`).finally(() => { process.exitCode = 130; });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const finish = (r, stateName, reason) => {
    r.state = stateName;
    r.reason = reason || null;
    r.finished_at = new Date().toISOString();
  };

  async function execute(t) {
    const r = rec.get(t.id);
    const wt = prepared.get(t.worktree);
    r.state = "running";
    r.started_at = new Date().toISOString();
    state.agents[t.owner] = { state: "working", task_id: t.id, task: t.task, commit: null, output: [] };
    await log(`${t.owner} start ${t.id}: ${t.task}`);

    if (!wt.ok) {
      finish(r, "blocked", wt.error);
    } else {
      const before = git(t.worktree, ["rev-parse", "HEAD"]).out;
      const def = AGENTS[t.agent];
      const taskLog = resolve(logDir, `${safeName(t.id)}.log`);
      const res = await run(def.bin(), def.args(t), t.worktree, {
        prefix: `[${t.owner}] `, quiet, logFile: taskLog, timeoutMs: t.timeout_minutes * 60_000, children, format: def.format,
        onLine: (line) => { r.output = [...r.output, line].slice(-OUTPUT_TAIL); state.agents[t.owner].output = r.output; saveSoon(); },
      });
      r.exit_code = res.code;
      const after = git(t.worktree, ["rev-parse", "HEAD"]).out;
      r.commit = after && after !== before ? after.slice(0, 12) : null;
      r.commits = r.commit ? git(t.worktree, ["log", "--format=%h %s", `${before}..${after}`]).out.split("\n").filter(Boolean) : [];
      r.dirty = git(t.worktree, ["status", "--porcelain"]).out.length > 0;

      if (interrupted) finish(r, "blocked", "interrupted");
      else if (res.error) finish(r, "blocked", res.error);
      else if (res.code !== 0) finish(r, "blocked", `agent exited with code ${res.code}`);
      else if (t.check) {
        await log(`${t.owner} checking ${t.id}: ${t.check}`);
        const c = await run(t.check, [], t.worktree, { shell: true, prefix: `[${t.owner} check] `, quiet, logFile: taskLog, timeoutMs: 30 * 60_000, children });
        r.check.passed = c.code === 0 && !c.error;
        if (r.check.passed) finish(r, "done");
        else finish(r, "blocked", `check failed (exit ${c.code})`);
      } else finish(r, "done");
      if (r.state === "done" && !r.commit) r.reason = "finished without a new commit";
    }

    state.agents[t.owner] = { state: r.state, task_id: t.id, task: t.task, commit: r.commit, output: r.output };
    await log(`${t.owner} ${r.state} ${t.id} ${r.commit || "—"}${r.reason ? ` (${r.reason})` : ""}`);
  }

  // Scheduler: each owner works through its own queue in order; a task starts once
  // its dependencies are done and no other task is using the same worktree.
  await save();
  const running = new Map();
  const busy = new Set();
  const stoppedOwners = new Map();
  while (true) {
    for (const t of tasks) {
      const r = rec.get(t.id);
      if (r.state !== "pending") continue;
      const failedDep = t.depends_on.find(d => ["blocked", "skipped"].includes(rec.get(d).state));
      if (interrupted) finish(r, "skipped", "interrupted");
      else if (stoppedOwners.has(t.owner)) finish(r, "skipped", `${t.owner} queue stopped after ${stoppedOwners.get(t.owner)} failed`);
      else if (failedDep) finish(r, "skipped", `dependency ${failedDep} did not complete`);
    }
    if (!interrupted) {
      const seenOwners = new Set();
      for (const t of tasks) {
        const r = rec.get(t.id);
        if (r.state === "done" || r.state === "blocked" || r.state === "skipped") continue;
        if (seenOwners.has(t.owner)) continue; // only the head of each owner's queue is eligible
        seenOwners.add(t.owner);
        if (r.state !== "pending" || busy.has(t.worktree)) continue;
        if (!t.depends_on.every(d => rec.get(d).state === "done")) continue;
        busy.add(t.worktree);
        const p = execute(t).finally(() => {
          busy.delete(t.worktree);
          running.delete(t.id);
          if (rec.get(t.id).state !== "done") stoppedOwners.set(t.owner, t.id);
        });
        running.set(t.id, p);
      }
    }
    if (running.size === 0) {
      const stuck = state.tasks.filter(r => r.state === "pending");
      for (const r of stuck) finish(r, "skipped", interrupted ? "interrupted" : "waiting on a task queued behind it (check queue order vs depends_on)");
      break;
    }
    await Promise.race(running.values());
  }

  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  clearTimeout(saveTimer);
  state.finished = true;
  const counts = state.tasks.reduce((a, r) => ({ ...a, [r.state]: (a[r.state] || 0) + 1 }), {});
  await log(`finished: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  await writeChain;
  return { ok: state.tasks.every(r => r.state === "done"), state };
}

async function ensureWorktree(root, t) {
  const path = t.worktree;
  let exists = false;
  try { exists = (await stat(path)).isDirectory(); } catch {}
  if (exists) {
    const top = git(path, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || (await realpath(top.out)) !== (await realpath(path))) {
      return { ok: false, error: `${path} exists but is not a git worktree; remove it or set a different "worktree"` };
    }
    return { ok: true, created: false };
  }
  const hasBranch = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${t.branch}`]).ok;
  const args = hasBranch ? ["worktree", "add", path, t.branch] : ["worktree", "add", "-b", t.branch, path, t.base];
  const r = git(root, args);
  return r.ok ? { ok: true, created: true } : { ok: false, error: r.err || `git worktree add failed for ${path}` };
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: !r.error && r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || r.error?.message || "").trim() };
}

function safeName(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function run(cmd, args, cwd, { prefix = "", quiet = false, logFile, timeoutMs, children, onLine, format, shell = false } = {}) {
  return new Promise((done) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; done(v); } };
    let child;
    try {
      child = spawn(cmd, args, { cwd, shell, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch (error) {
      return settle({ code: 127, error: `could not start ${cmd}: ${error.message}` });
    }
    children?.add(child);
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs) : null;
    const pending = { stdout: "", stderr: "" };
    const handle = (stream, chunk) => {
      const text = pending[stream] + chunk.toString();
      const lines = text.split("\n");
      pending[stream] = lines.pop();
      for (const line of lines) emit(line, stream);
    };
    const emit = (raw, stream) => {
      const lines = format ? format(raw) : [raw];
      for (const line of lines) emitLine(line, stream);
    };
    const emitLine = (line, stream) => {
      if (!quiet) (stream === "stderr" ? process.stderr : process.stdout).write(prefix + line + "\n");
      if (logFile) appendFile(logFile, line + "\n").catch(() => {});
      onLine?.(line);
    };
    child.stdout.on("data", (c) => handle("stdout", c));
    child.stderr.on("data", (c) => handle("stderr", c));
    child.on("error", (error) => {
      clearTimeout(timer);
      children?.delete(child);
      const msg = error.code === "ENOENT" ? `${cmd} is not installed or not on PATH` : error.message;
      emit(msg, "stderr");
      settle({ code: 127, error: msg });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      children?.delete(child);
      for (const s of ["stdout", "stderr"]) if (pending[s]) emit(pending[s], s);
      if (timedOut) settle({ code: code ?? 124, error: `timed out after ${Math.round(timeoutMs / 60000)} min` });
      else settle({ code: code ?? (signal ? 128 : 1) });
    });
  });
}

// Allow running this file directly: node supervisor.mjs [--dry-run]
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    const { ok } = await runWorkbench({ dryRun: process.argv.includes("--dry-run") });
    if (!process.exitCode) process.exitCode = ok ? 0 : 1;
  } catch (error) {
    console.error(`maw: ${error.message}`);
    process.exitCode = 2;
  }
}
