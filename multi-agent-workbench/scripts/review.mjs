// `maw review`, `maw merge` and `maw clean`: inspect, integrate and tidy up after a run.
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { git, findRepoRoot } from "./git.mjs";
import { commitLog } from "./supervisor.mjs";
import { loadPlan } from "./tasks.mjs";

async function loadStatus(root) {
  try {
    return JSON.parse(await readFile(resolve(root, ".agent-workbench/status.json"), "utf8"));
  } catch {
    throw new Error("No run found. Run `maw` in this project first.");
  }
}

function repo(cwd) {
  const root = findRepoRoot(cwd);
  if (!root) throw new Error(`${cwd} is not inside a git repository.`);
  return root;
}

/**
 * For each branch, the commit to merge: the last commit made by a `done` task, stopping at
 * the first task on that branch that did not finish (so partial queues merge only good work).
 */
export function mergeCandidates(status, only = null) {
  const byBranch = new Map();
  for (const t of status.tasks || []) {
    if (!byBranch.has(t.branch)) byBranch.set(t.branch, []);
    byBranch.get(t.branch).push(t);
  }
  const out = [];
  for (const [branch, list] of byBranch) {
    let commit = null;
    const included = [];
    const left = [];
    let stopped = false;
    for (const t of list) {
      if (!stopped && t.state === "done" && (!only || only.includes(t.id))) {
        included.push(t.id);
        const full = (t.commits || []).map(c => (typeof c === "string" ? c.split(" ")[0] : c.sha))[0];
        if (full || t.commit) commit = full || t.commit;
      } else {
        stopped = true;
        left.push(t.id);
      }
    }
    out.push({ branch, worktree: list[0].worktree, commit, included, left });
  }
  return out;
}

export async function review({ cwd = process.cwd(), json = false } = {}) {
  const root = repo(cwd);
  const status = await loadStatus(root);
  const report = (status.tasks || []).map(t => {
    const base = t.base_commit;
    const commits = base && t.worktree ? commitLog(t.worktree, `${base}..${t.branch}`) : [];
    const stat = base ? git(t.worktree, ["diff", "--shortstat", base, "HEAD"]).out : "";
    return { id: t.id, owner: t.owner, state: t.state, branch: t.branch, worktree: t.worktree, check: t.check, reason: t.reason, cost_usd: t.usage?.cost_usd || 0, commits, stat, dirty: t.dirty, files: t.files || [] };
  });
  if (json) {
    console.log(JSON.stringify({ plan: status.plan || null, finished: status.finished, tasks: report }, null, 2));
    return true;
  }
  if (status.plan?.title) console.log(`Plan: ${status.plan.title}\n`);
  for (const t of report) {
    const mark = { done: "✓", blocked: "✗", skipped: "–", running: "…", pending: "·" }[t.state] || "?";
    console.log(`${mark} ${t.id}  ${t.owner}  ${t.state}  [${t.branch}]${t.check ? `  check ${t.check.passed ? "passed" : t.check.passed === false ? "failed" : "not run"}` : ""}${t.cost_usd ? `  $${t.cost_usd.toFixed(2)}` : ""}`);
    if (t.reason) console.log(`    ${t.reason}`);
    for (const c of t.commits) console.log(`    ${c.short} ${c.subject}  (+${c.insertions} −${c.deletions})`);
    if (t.stat) console.log(`    ${t.stat}`);
    if (t.dirty) console.log(`    ! uncommitted changes left in ${t.worktree}`);
  }
  console.log("\nInspect a commit:  git -C <worktree> show <sha>");
  console.log("Merge finished work: maw merge   (into a maw/integration worktree; add --into-current to merge into your checkout)");
  return true;
}

export async function merge({ cwd = process.cwd(), only = null, intoCurrent = false, check = null, quiet = false } = {}) {
  const root = repo(cwd);
  const status = await loadStatus(root);
  if (!status.finished) throw new Error("The run is still going. Wait for it to finish before merging.");
  const say = (s) => { if (!quiet) console.log(s); };

  let target = root;
  let targetBranch;
  if (intoCurrent) {
    if (git(root, ["status", "--porcelain", "--untracked-files=no"]).out) throw new Error("Your checkout has uncommitted changes. Commit or stash them before merging.");
    targetBranch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  } else {
    targetBranch = "maw/integration";
    target = resolve(root, `../${basename(root)}-integration`);
    let exists = false;
    try { exists = (await stat(target)).isDirectory(); } catch {}
    if (!exists) {
      const hasBranch = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${targetBranch}`]).ok;
      const r = git(root, hasBranch ? ["worktree", "add", target, targetBranch] : ["worktree", "add", "-b", targetBranch, target, "HEAD"]);
      if (!r.ok) throw new Error(`could not create the integration worktree: ${r.err}`);
      say(`Created ${target} on ${targetBranch}`);
    } else if (git(target, ["status", "--porcelain", "--untracked-files=no"]).out) {
      throw new Error(`${target} has uncommitted changes. Clean it up before merging.`);
    }
  }

  const results = [];
  for (const c of mergeCandidates(status, only)) {
    if (!c.commit) { results.push({ ...c, result: "nothing to merge" }); continue; }
    if (git(target, ["merge-base", "--is-ancestor", c.commit, "HEAD"]).ok) { results.push({ ...c, result: "already merged" }); continue; }
    const m = git(target, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${c.branch} (maw tasks ${c.included.join(", ")})`, c.commit]);
    if (m.ok) { results.push({ ...c, result: "merged" }); continue; }
    const conflicts = git(target, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
    git(target, ["merge", "--abort"]);
    results.push({ ...c, result: "conflict", conflicts });
    break; // later branches may depend on this one; stop and let the user resolve it
  }

  for (const r of results) {
    say(`${r.result === "merged" ? "✓" : r.result === "conflict" ? "✗" : "–"} ${r.branch}: ${r.result}${r.included.length ? ` (${r.included.join(", ")})` : ""}${r.left.length ? `; not merged: ${r.left.join(", ")}` : ""}`);
    if (r.conflicts?.length) say(`    conflicts in: ${r.conflicts.join(", ")}\n    Resolve by hand: cd ${target} && git merge ${r.commit}`);
  }
  const conflict = results.some(r => r.result === "conflict");
  let checkPassed = null;
  if (!conflict && check) {
    say(`Running ${check} in ${target}…`);
    const c = spawnSync(check, { cwd: target, shell: true, stdio: quiet ? "ignore" : "inherit" });
    checkPassed = c.status === 0;
    say(checkPassed ? "✓ check passed on the merged result" : `✗ check failed (exit ${c.status})`);
  }
  if (!conflict && !intoCurrent && results.some(r => r.result === "merged")) {
    say(`\nReview ${targetBranch}, then bring it into your branch:\n  git merge --ff-only ${targetBranch}   (or open a pull request from it)`);
  }
  return { ok: !conflict && checkPassed !== false, results, target, branch: targetBranch };
}

export async function clean({ cwd = process.cwd(), taskPath = null, branches = false, force = false, quiet = false } = {}) {
  const root = repo(cwd);
  const say = (s) => { if (!quiet) console.log(s); };
  let tasks = [];
  try {
    ({ tasks } = await loadPlan(resolve(cwd, taskPath || "tasks.json"), root));
  } catch {
    const status = await loadStatus(root).catch(() => null);
    tasks = status?.tasks || [];
  }
  if (!tasks.length) throw new Error("Nothing to clean: no tasks.json or earlier run found.");
  const integration = { worktree: resolve(root, `../${basename(root)}-integration`), branch: "maw/integration" };
  const seen = new Set();
  let ok = true;
  for (const t of [...tasks, integration]) {
    if (seen.has(t.worktree)) continue;
    seen.add(t.worktree);
    let exists = false;
    try { exists = (await stat(t.worktree)).isDirectory(); } catch {}
    if (exists) {
      const r = git(root, ["worktree", "remove", ...(force ? ["--force"] : []), t.worktree]);
      if (r.ok) say(`removed worktree ${t.worktree}`);
      else { ok = false; say(`✗ kept ${t.worktree}: ${r.err.split("\n")[0]}${force ? "" : " (use --force to discard its changes)"}`); continue; }
    }
    if (branches && git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${t.branch}`]).ok) {
      const r = git(root, ["branch", force ? "-D" : "-d", t.branch]);
      if (r.ok) say(`deleted branch ${t.branch}`);
      else { ok = false; say(`✗ kept branch ${t.branch}: not merged yet (use --force to delete it anyway)`); }
    }
  }
  git(root, ["worktree", "prune"]);
  return ok;
}
