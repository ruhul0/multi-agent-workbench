import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { resolveAgent } from "./agents.mjs";

/** Load and validate tasks.json. Throws an Error with a user-facing message on any problem. */
export async function loadTasks(taskPath, root) {
  let raw;
  try {
    raw = await readFile(taskPath, "utf8");
  } catch {
    throw new Error(`No tasks.json found at ${taskPath}. Run \`maw init\` to create one.`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${taskPath} is not valid JSON: ${error.message}`);
  }
  const list = Array.isArray(data) ? data : data?.tasks;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`No tasks found in ${taskPath}. Add at least one task.`);
  }
  return normalizeTasks(list, root);
}

export function normalizeTasks(list, root) {
  const repoName = basename(root);
  const errors = [];
  const ids = new Set();
  const tasks = list.map((t, i) => {
    const where = `task #${i + 1}${t?.id ? ` (${t.id})` : ""}`;
    if (!t || typeof t !== "object") { errors.push(`${where}: must be an object`); return null; }
    if (!t.id) errors.push(`${where}: missing "id"`);
    else if (ids.has(t.id)) errors.push(`${where}: duplicate id "${t.id}"`);
    ids.add(t.id);
    if (!t.prompt) errors.push(`${where}: missing "prompt"`);
    const agent = resolveAgent(t);
    if (!agent) errors.push(`${where}: unknown agent "${t.command || t.owner}" (use claude, codex or agy)`);
    const owner = t.owner || agent;
    const deps = t.depends_on ?? t.dependencies ?? [];
    if (!Array.isArray(deps)) errors.push(`${where}: "depends_on" must be an array of task ids`);
    return {
      id: String(t.id),
      owner: String(owner),
      agent,
      task: t.task || t.prompt?.slice(0, 80) || "",
      prompt: t.prompt,
      worktree: resolve(root, t.worktree || `../${repoName}-${owner}`),
      branch: t.branch || `maw/${owner}`,
      base: t.base || "HEAD",
      depends_on: Array.isArray(deps) ? deps.map(String) : [],
      check: t.check || null,
      model: t.model || null,
      effort: t.effort || null,
      timeout_minutes: Number(t.timeout_minutes) || 60,
    };
  });
  if (errors.length) throw new Error(`Invalid tasks.json:\n  - ${errors.join("\n  - ")}`);

  for (const t of tasks) for (const d of t.depends_on) {
    if (!ids.has(d)) errors.push(`${t.id}: depends on unknown task "${d}"`);
    if (d === t.id) errors.push(`${t.id}: depends on itself`);
  }
  // Owners sharing a worktree must also share a branch, otherwise checkouts collide.
  const byPath = new Map();
  for (const t of tasks) {
    const prev = byPath.get(t.worktree);
    if (prev && prev.branch !== t.branch) errors.push(`${t.id}: worktree ${t.worktree} is already used with branch ${prev.branch}`);
    byPath.set(t.worktree, t);
  }
  if (!errors.length) {
    const cycle = findCycle(tasks);
    if (cycle) errors.push(`dependency cycle: ${cycle.join(" -> ")}`);
  }
  if (errors.length) throw new Error(`Invalid tasks.json:\n  - ${errors.join("\n  - ")}`);
  return tasks;
}

function findCycle(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1); stack.push(id);
    for (const d of byId.get(id).depends_on) { const c = visit(d); if (c) return c; }
    stack.pop(); state.set(id, 2);
    return null;
  };
  for (const t of tasks) { const c = visit(t.id); if (c) return c; }
  return null;
}
