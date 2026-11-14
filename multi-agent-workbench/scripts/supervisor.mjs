#!/usr/bin/env node
// Multi-agent workbench supervisor: runs tasks.json across agent CLIs in isolated git worktrees.
import { mkdir, writeFile, appendFile, rename, readFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { expandTemplate } from "./agents.mjs";
import { loadPlan } from "./tasks.mjs";
import { git, findRepoRoot, ensureWorktree } from "./git.mjs";
import { notify } from "./notify.mjs";

export { findRepoRoot } from "./git.mjs";

const OUTPUT_TAIL = 40;
const MAX_LINE = 2000;
const FEEDBACK_LINES = 60;
const REFRESH_MS = 4000;
// Variables every agent needs even when tasks.json restricts the environment with env.allow.
const ESSENTIAL_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "USERPROFILE"];

/**
 * Run the task queue.
 * `control` (optional) receives `stopTask(id)` and `stopAll()` so the dashboard can stop work.
 */
export async function runWorkbench({
  root = process.env.WORKBENCH_ROOT || process.cwd(),
  taskPath = process.env.WORKBENCH_TASKS,
  dryRun = false,
  quiet = false,
  resume = false,
  maxParallel = null,
  notifyDesktop = false,
  control = null,
} = {}) {
  const cwd = resolve(root);
  taskPath = resolve(cwd, taskPath || "tasks.json");
  // Worktrees and .agent-workbench live relative to the repository root, even when
  // maw is started from a subdirectory (otherwise worktrees would nest inside the repo).
  root = findRepoRoot(cwd);
  if (!root) throw new Error(`${cwd} is not inside a git repository. Run \`git init\` and make a first commit.`);
  const { tasks, settings, registry } = await loadPlan(taskPath, root);
  if (!git(root, ["rev-parse", "--verify", "HEAD"]).ok) throw new Error("The repository has no commits yet. Make an initial commit so worktrees can be created.");
  const parallel = maxParallel || settings.max_parallel;

  if (dryRun) {
    if (settings.plan?.title) console.log(`Plan: ${settings.plan.title}`);
    for (const t of tasks) {
      console.log(`${t.id}  ${t.owner} (${t.agent})  ${t.worktree} [${t.branch}]${t.isolate ? "  isolated" : ""}${t.depends_on.length ? `  after ${t.depends_on.join(", ")}` : ""}${t.check ? `  check: ${t.check}` : ""}${t.retries ? `  retries: ${t.retries}` : ""}`);
    }
    const extras = [
      Number.isFinite(parallel) && `max ${parallel} at once`,
      settings.budget_usd && `budget $${settings.budget_usd}`,
      settings.env?.allow && `env limited to ${settings.env.allow.length} extra variable(s)`,
      settings.sandbox && `sandbox: ${settings.sandbox[0]}`,
    ].filter(Boolean);
    if (extras.length) console.log(extras.join(" · "));
    return { ok: true, tasks };
  }

  const dir = resolve(root, ".agent-workbench");
  const logDir = resolve(dir, "logs");
  await mkdir(logDir, { recursive: true });
  ignoreStateDir(root);
  const statePath = resolve(dir, "status.json");
  const logPath = resolve(dir, "supervisor.log");
  const releaseLock = await acquireLock(resolve(dir, "run.lock"));

  const previous = resume ? await readJson(statePath) : null;

  const state = {
    root,
    plan: settings.plan,
    started_at: new Date().toISOString(),
    finished: false,
    budget_usd: settings.budget_usd,
    usage: emptyUsage(),
    agents: {},
    tasks: tasks.map(t => ({
      id: t.id, owner: t.owner, agent: t.agent, agent_label: registry[t.agent]?.label || t.agent, task: t.task, prompt: t.prompt,
      worktree: t.worktree, branch: t.branch, depends_on: t.depends_on, isolate: t.isolate,
      state: "pending", attempt: 0, attempts: 1 + t.retries, base_commit: null, commit: null, commits: [], files: [], dirty: false,
      check: t.check ? { command: t.check, passed: null } : null, exit_code: null, reason: null,
      started_at: null, finished_at: null, usage: emptyUsage(), output: [],
    })),
    recent: [],
  };
  const rec = new Map(state.tasks.map(r => [r.id, r]));

  // Serialized, atomic status writes so parallel agents can't corrupt status.json.
  let writeChain = Promise.resolve();
  let warnedWrite = false;
  const save = () => {
    const snapshot = JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2);
    writeChain = writeChain.then(async () => {
      const tmp = `${statePath}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, statePath);
    }).catch((error) => {
      if (!warnedWrite) { warnedWrite = true; console.error(`maw: could not write ${statePath}: ${error.message}`); }
    });
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
    state.recent = [...state.recent, s].slice(-60);
    if (!quiet) console.log(`maw: ${line}`);
    await appendFile(logPath, s + "\n");
    await save();
  };

  try {
    await log(`run started${settings.plan?.title ? `: ${settings.plan.title}` : ""} (${tasks.length} tasks)`);

    // Carry over tasks finished in an earlier run (maw run --resume).
    if (previous?.tasks) {
      for (const old of previous.tasks) {
        const r = rec.get(old.id);
        if (!r || old.state !== "done" || old.prompt !== r.prompt || old.worktree !== r.worktree) continue;
        if (old.commit && !git(r.worktree, ["merge-base", "--is-ancestor", old.commit, "HEAD"]).ok) continue;
        Object.assign(r, { ...old, output: old.output || [], reason: "done in an earlier run", resumed: true });
        await log(`${r.owner} keeps ${r.id} from the earlier run`);
      }
    }

    // Create worktrees up front, sequentially (git holds a lock on worktree metadata).
    const prepared = new Map();
    for (const t of tasks) {
      if (prepared.has(t.worktree)) continue;
      const result = await ensureWorktree(root, t);
      prepared.set(t.worktree, result);
      if (!result.ok) await log(`worktree error for ${t.id}: ${result.error}`);
      else if (result.created) await log(`created worktree ${t.worktree} on ${t.branch}`);
      for (const w of result.warnings || []) await log(`warning: ${w}`);
    }

    const children = new Map(); // task id -> Set of child processes
    const allChildren = () => [...children.values()].flatMap(s => [...s]);
    let interrupted = false;
    const onSignal = (signal) => {
      if (interrupted) {
        // Second Ctrl+C: stop waiting for agents that ignore SIGTERM.
        for (const c of allChildren()) killTree(c, "SIGKILL");
        console.error("maw: forced exit");
        releaseLock();
        process.exit(130);
      }
      interrupted = true;
      for (const c of allChildren()) killTree(c, "SIGTERM");
      // Escalate if an agent is still alive after a grace period.
      setTimeout(() => { for (const c of allChildren()) killTree(c, "SIGKILL"); }, 10_000).unref();
      log(`received ${signal}; stopping agents (press Ctrl+C again to force)`).finally(() => { process.exitCode = 130; });
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    const stopRequested = new Set();
    if (control) {
      control.stopTask = (id) => {
        const r = rec.get(id);
        if (!r) return false;
        if (r.state === "pending") { finish(r, "skipped", "stopped from the dashboard"); log(`${r.owner} skipped ${id} (stopped from the dashboard)`); return true; }
        if (r.state !== "running") return false;
        stopRequested.add(id);
        for (const c of children.get(id) || []) killTree(c, "SIGTERM");
        log(`stopping ${id} (requested from the dashboard)`);
        return true;
      };
      control.stopAll = () => { onSignal("stop request"); return true; };
    }

    const finish = (r, stateName, reason) => {
      r.state = stateName;
      r.reason = reason || null;
      r.finished_at = new Date().toISOString();
    };
    const totalCost = () => state.tasks.reduce((n, r) => n + (r.usage?.cost_usd || 0), 0);
    const overBudget = () => settings.budget_usd != null && totalCost() >= settings.budget_usd;

    const baseEnv = buildEnv(settings.env);
    const wrap = (cmd, args, t) => {
      if (!settings.sandbox) return [cmd, args];
      const prefix = expandTemplate(settings.sandbox, { worktree: t.worktree, id: t.id, owner: t.owner, root });
      return [prefix[0], [...prefix.slice(1), cmd, ...args]];
    };

    async function execute(t) {
      const r = rec.get(t.id);
      const wt = prepared.get(t.worktree);
      const def = registry[t.agent];
      r.state = "running";
      r.started_at = new Date().toISOString();
      state.agents[t.owner] = { state: "working", task_id: t.id, task: t.task, commit: null, output: [] };
      await log(`${t.owner} start ${t.id}: ${t.task}`);

      if (!wt.ok) {
        finish(r, "blocked", wt.error);
      } else {
        const before = git(t.worktree, ["rev-parse", "HEAD"]).out;
        r.base_commit = before;
        const taskLog = resolve(logDir, `${t.id}.log`);
        const env = { ...baseEnv, MAW_TASK_ID: t.id, MAW_OWNER: t.owner, MAW_BRANCH: t.branch };
        const refresh = () => { refreshChanges(r, t.worktree, before); saveSoon(); };
        const ticker = setInterval(refresh, REFRESH_MS);
        ticker.unref?.();
        const track = (child) => {
          if (!children.has(t.id)) children.set(t.id, new Set());
          children.get(t.id).add(child);
          return () => children.get(t.id)?.delete(child);
        };
        const onLine = (line) => {
          r.output = [...r.output, line].slice(-OUTPUT_TAIL);
          state.agents[t.owner].output = r.output;
          saveSoon();
        };

        let prompt = t.prompt;
        let session = null;
        try {
          for (let attempt = 1; attempt <= 1 + t.retries; attempt++) {
            r.attempt = attempt;
            if (attempt > 1) await log(`${t.owner} retry ${t.id} (attempt ${attempt} of ${1 + t.retries})`);
            const resumeId = def.resume && session ? session : null;
            const [cmd, args] = wrap(def.bin(), def.args(t, { prompt, resume: resumeId }), t);
            const usage = emptyUsage();
            const res = await run(cmd, args, t.worktree, {
              prefix: `[${t.owner}] `, quiet, logFile: taskLog, timeoutMs: t.timeout_minutes * 60_000, track, env, format: def.format,
              onRaw: def.parse ? (line) => {
                const p = def.parse(line);
                if (p?.session_id) session = p.session_id;
                if (p?.usage) addUsage(usage, p.usage);
              } : null,
              onLine,
            });
            addUsage(r.usage, usage);
            addUsage(state.usage, usage);
            r.exit_code = res.code;
            refresh();

            if (interrupted) { finish(r, "blocked", "interrupted"); break; }
            if (stopRequested.has(t.id)) { finish(r, "blocked", "stopped from the dashboard"); break; }

            let problem = null;
            let feedback = null;
            if (res.error) {
              problem = res.error;
              feedback = res.timedOut
                ? `Your previous attempt was stopped after ${t.timeout_minutes} minutes. Finish the task more directly: make the smallest change that works, run the relevant tests, and commit.`
                : null;
              if (res.code === 127) { finish(r, "blocked", problem); break; } // not installed: retrying cannot help
            } else if (res.code !== 0) {
              problem = `agent exited with code ${res.code}`;
              feedback = `Your previous attempt ended with exit code ${res.code}. The last output was:\n\n${fence(r.output.slice(-FEEDBACK_LINES))}\n\nResolve the problem, run the relevant tests, and commit your changes.`;
            } else if (t.check) {
              await log(`${t.owner} checking ${t.id}: ${t.check}`);
              const checkOut = [];
              const [ccmd, cargs] = settings.sandbox ? wrap("sh", ["-c", t.check], t) : [t.check, []];
              const c = await run(ccmd, cargs, t.worktree, {
                shell: !settings.sandbox, prefix: `[${t.owner} check] `, quiet, logFile: taskLog, timeoutMs: t.check_timeout_minutes * 60_000, track, env,
                onLine: (line) => { checkOut.push(line); if (checkOut.length > 400) checkOut.shift(); onLine(`[check] ${line}`); },
              });
              r.check.passed = c.code === 0 && !c.error;
              if (!r.check.passed) {
                problem = c.timedOut ? `check timed out after ${t.check_timeout_minutes} min` : `check failed (exit ${c.code})`;
                feedback = `The acceptance check \`${t.check}\` failed (${c.timedOut ? "timed out" : `exit ${c.code}`}) after your changes. Its output was:\n\n${fence(checkOut.slice(-FEEDBACK_LINES))}\n\nFix the cause, run \`${t.check}\` yourself until it passes, and commit the fix.`;
              }
            }

            if (!problem) { finish(r, "done"); break; }
            const budgetLeft = !overBudget() && !(t.max_cost_usd && r.usage.cost_usd >= t.max_cost_usd);
            if (attempt > t.retries || !feedback || !budgetLeft) {
              finish(r, "blocked", attempt > 1 ? `${problem} (after ${attempt} attempts)` : problem);
              break;
            }
            await log(`${t.owner} ${t.id}: ${problem}; sending the error back to the agent`);
            prompt = resumeId || (def.resume && session) ? feedback : `${t.prompt}\n\n---\n${feedback}`;
          }
        } finally {
          clearInterval(ticker);
          children.delete(t.id);
        }
        refreshChanges(r, t.worktree, before);
        if (r.state === "done" && !r.commit) r.reason = "finished without a new commit";
      }

      state.agents[t.owner] = { state: r.state, task_id: t.id, task: t.task, commit: r.commit, output: r.output };
      const cost = r.usage.cost_usd ? ` $${r.usage.cost_usd.toFixed(2)}` : "";
      await log(`${t.owner} ${r.state} ${t.id} ${r.commit || "—"}${cost}${r.reason ? ` (${r.reason})` : ""}`);
    }

    // Scheduler. Queued tasks of one owner run in order in that owner's worktree; isolated
    // tasks get their own worktree and run as soon as their dependencies are done.
    await save();
    const running = new Map();
    const busy = new Set();
    const stoppedOwners = new Map();
    let budgetLogged = false;
    while (true) {
      for (const t of tasks) {
        const r = rec.get(t.id);
        if (r.state !== "pending") continue;
        const failedDep = t.depends_on.find(d => ["blocked", "skipped"].includes(rec.get(d).state));
        if (interrupted) finish(r, "skipped", "interrupted");
        else if (!t.isolate && stoppedOwners.has(t.owner)) finish(r, "skipped", `${t.owner} queue stopped after ${stoppedOwners.get(t.owner)} failed`);
        else if (failedDep) finish(r, "skipped", `dependency ${failedDep} did not complete`);
        else if (overBudget()) {
          finish(r, "skipped", `budget of $${settings.budget_usd} reached`);
          if (!budgetLogged) { budgetLogged = true; await log(`budget of $${settings.budget_usd} reached; not starting new tasks`); }
        }
      }
      if (!interrupted) {
        const seenOwners = new Set();
        for (const t of tasks) {
          const r = rec.get(t.id);
          const terminal = r.state === "done" || r.state === "blocked" || r.state === "skipped";
          if (!t.isolate) {
            if (terminal || seenOwners.has(t.owner)) continue;
            seenOwners.add(t.owner); // only the head of each owner's queue is eligible
          }
          if (r.state !== "pending" || busy.has(t.worktree)) continue;
          if (running.size >= parallel) break;
          if (!t.depends_on.every(d => rec.get(d).state === "done")) continue;
          busy.add(t.worktree);
          const p = execute(t).catch(async (error) => {
            finish(r, "blocked", `internal error: ${error.message}`);
            await log(`${t.owner} blocked ${t.id} (internal error: ${error.message})`);
          }).finally(() => {
            busy.delete(t.worktree);
            running.delete(t.id);
            if (!t.isolate && rec.get(t.id).state !== "done") stoppedOwners.set(t.owner, t.id);
          });
          running.set(t.id, p);
        }
      }
      if (running.size === 0) {
        const stuck = state.tasks.filter(r => r.state === "pending");
        for (const r of stuck) finish(r, "skipped", interrupted ? "interrupted" : "could not be scheduled");
        break;
      }
      await Promise.race(running.values());
    }

    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    clearTimeout(saveTimer);
    state.finished = true;
    const counts = state.tasks.reduce((a, r) => ({ ...a, [r.state]: (a[r.state] || 0) + 1 }), {});
    const summary = `finished: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}${state.usage.cost_usd ? ` · $${state.usage.cost_usd.toFixed(2)}` : ""}`;
    await log(summary);
    await writeChain;
    const ok = state.tasks.every(r => r.state === "done");
    if (notifyDesktop || settings.notify.desktop || settings.notify.webhook) {
      await notify({ desktop: notifyDesktop || settings.notify.desktop, webhook: settings.notify.webhook, title: ok ? "maw: all tasks done" : "maw: finished with issues", message: summary.replace(/^finished: /, ""), state });
    }
    return { ok, state };
  } finally {
    releaseLock();
  }
}

/** Update commit history and changed files for a task from its worktree. */
function refreshChanges(r, worktree, before) {
  const after = git(worktree, ["rev-parse", "HEAD"]).out;
  r.commit = after && after !== before ? after.slice(0, 12) : null;
  r.commits = r.commit ? commitLog(worktree, `${before}..${after}`) : [];
  const files = git(worktree, ["diff", "--name-status", before]).out;
  const untracked = git(worktree, ["ls-files", "--others", "--exclude-standard"]).out;
  r.files = [
    ...files.split("\n").filter(Boolean).map(l => { const [status, ...rest] = l.split("\t"); return { status: status[0], path: rest.at(-1) }; }),
    ...untracked.split("\n").filter(Boolean).map(path => ({ status: "?", path })),
  ].slice(0, 300);
  r.dirty = git(worktree, ["status", "--porcelain"]).out.length > 0;
}

/** Commits in a range, newest first, with author time and line stats. */
export function commitLog(cwd, range) {
  const out = git(cwd, ["log", "--format=%x1e%H%x1f%h%x1f%s%x1f%aI%x1f%an", "--shortstat", range]).out;
  return out.split("\x1e").filter(s => s.trim()).map(chunk => {
    const [head, ...rest] = chunk.trim().split("\n");
    const [sha, short, subject, time, author] = head.split("\x1f");
    const stat = rest.join(" ");
    const pick = (re) => Number(stat.match(re)?.[1] || 0);
    return { sha, short, subject, time, author, files: pick(/(\d+) files? changed/), insertions: pick(/(\d+) insertions?/), deletions: pick(/(\d+) deletions?/) };
  });
}

function emptyUsage() {
  return { cost_usd: 0, turns: 0, input_tokens: 0, output_tokens: 0 };
}

function addUsage(into, u) {
  for (const k of Object.keys(into)) into[k] += Number(u[k]) || 0;
}

function fence(lines) {
  return "```\n" + (lines.join("\n") || "(no output)") + "\n```";
}

function buildEnv(config) {
  if (!config) return { ...process.env };
  const env = {};
  if (config.allow) {
    for (const k of [...ESSENTIAL_ENV, ...config.allow]) if (process.env[k] != null) env[k] = process.env[k];
  } else Object.assign(env, process.env);
  for (const [k, v] of Object.entries(config.set || {})) env[k] = String(v);
  return env;
}

/** Keep .agent-workbench out of `git status` without touching the project's .gitignore. */
function ignoreStateDir(root) {
  const p = git(root, ["rev-parse", "--git-path", "info/exclude"]);
  if (!p.ok) return;
  const file = resolve(root, p.out);
  readFile(file, "utf8").catch(() => "").then(async (text) => {
    if (text.split("\n").some(l => l.trim() === ".agent-workbench/" || l.trim() === ".agent-workbench")) return;
    await mkdir(resolve(file, ".."), { recursive: true });
    await appendFile(file, `${text && !text.endsWith("\n") ? "\n" : ""}# multi-agent-workbench state\n.agent-workbench/\n`);
  }).catch(() => {});
}

/** One run per repository at a time. Returns a release function. */
async function acquireLock(path) {
  const take = () => writeFile(path, String(process.pid), { flag: "wx" });
  try {
    await take();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(await readFile(path, "utf8").catch(() => ""));
    if (pid && pid !== process.pid && isAlive(pid)) {
      throw new Error(`another maw run (pid ${pid}) is already running in this repository. Wait for it or stop it first.`);
    }
    await unlink(path).catch(() => {});
    await take();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlink(path).catch(() => {});
  };
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

/** Signal a child and everything it started (its process group on POSIX). */
function killTree(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function run(cmd, args, cwd, { prefix = "", quiet = false, logFile, timeoutMs, track, onLine, onRaw, format, env = process.env, shell = false } = {}) {
  return new Promise((done) => {
    let settled = false;
    let untrack = () => {};
    const settle = (v) => { if (!settled) { settled = true; untrack(); done(v); } };
    let child;
    try {
      // detached on POSIX puts the child in its own process group, so timeouts and
      // Ctrl+C can stop the whole tree (agent tools, test runners), not just the CLI.
      child = spawn(cmd, args, { cwd, shell, stdio: ["ignore", "pipe", "pipe"], env, detached: process.platform !== "win32" });
    } catch (error) {
      return settle({ code: 127, error: `could not start ${cmd}: ${error.message}` });
    }
    untrack = track?.(child) || untrack;
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 10_000).unref();
    }, timeoutMs) : null;
    const pending = { stdout: "", stderr: "" };
    const handle = (stream, chunk) => {
      const text = pending[stream] + chunk.toString();
      const lines = text.split("\n");
      pending[stream] = lines.pop();
      for (const line of lines) emit(line, stream);
    };
    const emit = (raw, stream) => {
      if (stream === "stdout") onRaw?.(raw);
      const lines = format && stream === "stdout" ? format(raw) : [raw];
      for (const line of lines) emitLine(line.length > MAX_LINE ? line.slice(0, MAX_LINE) + " …" : line, stream);
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
      const msg = error.code === "ENOENT" ? `${cmd} is not installed or not on PATH` : error.message;
      emit(msg, "stderr");
      settle({ code: 127, error: msg });
    });
    // A background process that inherited stdout can keep the pipes open long after
    // the agent exits; stop waiting for them shortly after the agent itself is gone.
    child.on("exit", () => {
      setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 2000).unref();
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      for (const s of ["stdout", "stderr"]) if (pending[s]) emit(pending[s], s);
      if (timedOut) settle({ code: code ?? 124, timedOut: true, error: `timed out after ${+(timeoutMs / 60000).toFixed(1)} min` });
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
