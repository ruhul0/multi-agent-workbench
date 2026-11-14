import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { agentRegistry, resolveAgent, validateCustomAgent } from "./agents.mjs";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Load and validate tasks.json. Returns { tasks, settings, registry }.
 * Throws an Error with a user-facing message on any problem.
 */
export async function loadPlan(taskPath, root) {
  let raw;
  try {
    raw = await readFile(taskPath, "utf8");
  } catch {
    throw new Error(`No tasks.json found at ${taskPath}. Run \`maw init\` or \`maw plan\` to create one.`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${taskPath} is not valid JSON: ${error.message}`);
  }
  return parsePlan(data, root, taskPath);
}

/** Validate an already-parsed tasks.json value (array or object form). */
export function parsePlan(data, root, label = "tasks.json") {
  const list = Array.isArray(data) ? data : data?.tasks;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`No tasks found in ${label}. Add at least one task.`);
  }
  const settings = normalizeSettings(Array.isArray(data) ? {} : data);
  const registry = agentRegistry(settings.agents);
  const tasks = normalizeTasks(list, root, registry);
  return { tasks, settings, registry };
}

/** Backwards-compatible helper: just the tasks. */
export async function loadTasks(taskPath, root) {
  return (await loadPlan(taskPath, root)).tasks;
}

export function normalizeSettings(data = {}) {
  const errors = [];
  const s = {
    plan: null,
    agents: {},
    max_parallel: Infinity,
    budget_usd: null,
    env: null,
    sandbox: null,
    notify: { desktop: false, webhook: null },
  };
  if (data.plan != null) {
    if (typeof data.plan !== "object") errors.push(`"plan" must be an object like { "title": "...", "summary": "..." }`);
    else s.plan = { title: String(data.plan.title || ""), summary: String(data.plan.summary || ""), source: data.plan.source ? String(data.plan.source) : null };
  }
  if (data.agents != null) {
    if (typeof data.agents !== "object" || Array.isArray(data.agents)) errors.push(`"agents" must be an object of custom agent definitions`);
    else for (const [name, spec] of Object.entries(data.agents)) errors.push(...validateCustomAgent(name, spec));
    s.agents = data.agents || {};
  }
  if (data.max_parallel != null) {
    if (!Number.isInteger(data.max_parallel) || data.max_parallel < 1) errors.push(`"max_parallel" must be a whole number of at least 1`);
    else s.max_parallel = data.max_parallel;
  }
  if (data.budget_usd != null) {
    if (typeof data.budget_usd !== "number" || !(data.budget_usd > 0)) errors.push(`"budget_usd" must be a positive number`);
    else s.budget_usd = data.budget_usd;
  }
  if (data.env != null) {
    const e = data.env;
    if (typeof e !== "object" || Array.isArray(e)) errors.push(`"env" must be an object like { "allow": ["PATH", "HOME"], "set": { "CI": "1" } }`);
    else {
      if (e.allow != null && (!Array.isArray(e.allow) || e.allow.some(k => typeof k !== "string"))) errors.push(`"env.allow" must be an array of variable names`);
      if (e.set != null && (typeof e.set !== "object" || Array.isArray(e.set))) errors.push(`"env.set" must be an object of NAME: value`);
      s.env = { allow: e.allow || null, set: e.set || {} };
    }
  }
  if (data.sandbox != null) {
    if (!Array.isArray(data.sandbox) || !data.sandbox.length || data.sandbox.some(a => typeof a !== "string")) errors.push(`"sandbox" must be an argv prefix such as ["docker", "run", "--rm", "-v", "{worktree}:{worktree}", "-w", "{worktree}", "my-image"]`);
    else s.sandbox = data.sandbox;
  }
  if (data.notify != null) {
    const n = data.notify;
    if (typeof n !== "object" || Array.isArray(n)) errors.push(`"notify" must be an object like { "desktop": true, "webhook": "https://..." }`);
    else {
      if (n.webhook != null && !/^https?:\/\//.test(String(n.webhook))) errors.push(`"notify.webhook" must be an http(s) URL`);
      s.notify = { desktop: n.desktop === true, webhook: n.webhook || null };
    }
  }
  if (errors.length) throw new Error(`Invalid tasks.json:\n  - ${errors.join("\n  - ")}`);
  return s;
}

export function normalizeTasks(list, root, registry = agentRegistry()) {
  const repoName = basename(root);
  const errors = [];
  const ids = new Set();
  const known = Object.keys(registry).join(", ");
  const tasks = list.map((t, i) => {
    const where = `task #${i + 1}${t?.id ? ` (${t.id})` : ""}`;
    if (!t || typeof t !== "object") { errors.push(`${where}: must be an object`); return null; }
    const id = t.id == null ? "" : String(t.id);
    if (!id) errors.push(`${where}: missing "id"`);
    else if (!SAFE_NAME.test(id)) errors.push(`${where}: "id" may only use letters, digits, ".", "_" and "-"`);
    else if (ids.has(id)) errors.push(`${where}: duplicate id "${id}"`);
    ids.add(id);
    if (typeof t.prompt !== "string" || !t.prompt.trim()) errors.push(`${where}: "prompt" must be a non-empty string`);
    const agent = resolveAgent(t, registry);
    if (!agent) errors.push(`${where}: unknown agent "${t.command || t.owner}" (use ${known}, or define it under "agents")`);
    const owner = String(t.owner || agent || "");
    if (owner && !SAFE_NAME.test(owner)) errors.push(`${where}: "owner" may only use letters, digits, ".", "_" and "-"`);
    const deps = t.depends_on ?? t.dependencies ?? [];
    if (!Array.isArray(deps)) errors.push(`${where}: "depends_on" must be an array of task ids`);
    const positive = (field, fallback) => {
      if (t[field] == null) return fallback;
      const n = Number(t[field]);
      if (!(n > 0)) { errors.push(`${where}: "${field}" must be a positive number`); return fallback; }
      return n;
    };
    let retries = 0;
    if (t.retries != null) {
      if (!Number.isInteger(t.retries) || t.retries < 0 || t.retries > 5) errors.push(`${where}: "retries" must be a whole number from 0 to 5`);
      else retries = t.retries;
    }
    const isolate = t.isolate === true;
    const slug = isolate ? `${owner}-${id}` : owner;
    return {
      id,
      owner,
      agent,
      task: String(t.task || (typeof t.prompt === "string" ? t.prompt.slice(0, 80) : "")),
      prompt: t.prompt,
      worktree: resolve(root, t.worktree || `../${repoName}-${slug}`),
      branch: String(t.branch || `maw/${slug}`),
      base: String(t.base || "HEAD"),
      depends_on: Array.isArray(deps) ? deps.map(String) : [],
      check: t.check || null,
      check_timeout_minutes: positive("check_timeout_minutes", 30),
      model: t.model || null,
      effort: t.effort || null,
      timeout_minutes: positive("timeout_minutes", 60),
      max_cost_usd: positive("max_cost_usd", null),
      retries,
      isolate,
    };
  });
  if (errors.length) throw new Error(`Invalid tasks.json:\n  - ${errors.join("\n  - ")}`);

  for (const t of tasks) for (const d of t.depends_on) {
    if (!ids.has(d)) errors.push(`${t.id}: depends on unknown task "${d}"`);
    if (d === t.id) errors.push(`${t.id}: depends on itself`);
  }
  // A worktree has exactly one branch, and git checks a branch out in only one worktree.
  const byPath = new Map();
  const byBranch = new Map();
  for (const t of tasks) {
    const prev = byPath.get(t.worktree);
    if (prev && prev.branch !== t.branch) errors.push(`${t.id}: worktree ${t.worktree} is already used with branch ${prev.branch}`);
    byPath.set(t.worktree, t);
    const other = byBranch.get(t.branch);
    if (other && other.worktree !== t.worktree) errors.push(`${t.id}: branch ${t.branch} is already checked out in ${other.worktree} (task ${other.id})`);
    byBranch.set(t.branch, t);
  }
  if (!errors.length) {
    const cycle = findCycle(tasks);
    if (cycle) errors.push(`dependency cycle: ${cycle.join(" -> ")} (queued tasks run in order, so a task also waits for the one before it in its owner's queue)`);
  }
  if (errors.length) throw new Error(`Invalid tasks.json:\n  - ${errors.join("\n  - ")}`);
  return tasks;
}

/** Tasks that wait for each other: explicit depends_on plus the previous task in the same owner queue. */
export function waitsFor(tasks) {
  const edges = new Map(tasks.map(t => [t.id, [...t.depends_on]]));
  const lastInQueue = new Map();
  for (const t of tasks) {
    if (t.isolate) continue;
    const prev = lastInQueue.get(t.owner);
    if (prev) edges.get(t.id).push(prev);
    lastInQueue.set(t.owner, t.id);
  }
  return edges;
}

function findCycle(tasks) {
  const edges = waitsFor(tasks);
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1); stack.push(id);
    for (const d of edges.get(id)) { const c = visit(d); if (c) return c; }
    stack.pop(); state.set(id, 2);
    return null;
  };
  for (const t of tasks) { const c = visit(t.id); if (c) return c; }
  return null;
}
