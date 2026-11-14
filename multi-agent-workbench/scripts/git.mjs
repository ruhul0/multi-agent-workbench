// Small git helpers shared by the supervisor and the review/merge/clean commands.
import { spawnSync } from "node:child_process";
import { stat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

export function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: !r.error && r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || r.error?.message || "").trim() };
}

/** Absolute path of the git repository containing `cwd`, or null. */
export function findRepoRoot(cwd = process.cwd()) {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok && r.out ? resolve(r.out) : null;
}

/** Create (or reuse) the worktree for a task. */
export async function ensureWorktree(root, t) {
  const path = t.worktree;
  let exists = false;
  try { exists = (await stat(path)).isDirectory(); } catch {}
  if (exists) {
    const top = git(path, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || (await realpath(top.out)) !== (await realpath(path))) {
      return { ok: false, error: `${path} exists but is not a git worktree; remove it or set a different "worktree"` };
    }
    const warnings = [];
    if (git(path, ["status", "--porcelain"]).out) warnings.push(`${path} has uncommitted changes from an earlier run`);
    // Resolve base in the main checkout: "HEAD" means the project's HEAD, not the worktree's.
    const baseSha = git(root, ["rev-parse", "--verify", `${t.base}^{commit}`]).out;
    const behind = baseSha ? git(path, ["rev-list", "--count", `HEAD..${baseSha}`]) : { ok: false };
    if (behind.ok && Number(behind.out) > 0) warnings.push(`${t.branch} is ${behind.out} commit(s) behind ${t.base}; merge or rebase it if the task needs newer code`);
    return { ok: true, created: false, warnings };
  }
  const hasBranch = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${t.branch}`]).ok;
  const args = hasBranch ? ["worktree", "add", path, t.branch] : ["worktree", "add", "-b", t.branch, path, t.base];
  const r = git(root, args);
  return r.ok ? { ok: true, created: true, warnings: [] } : { ok: false, error: r.err || `git worktree add failed for ${path}` };
}
