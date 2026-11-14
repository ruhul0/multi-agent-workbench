import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AGENTS } from "./agents.mjs";
import { loadPlan } from "./tasks.mjs";

/**
 * Check that each agent CLI is installed and logged in. Never prints CLI output,
 * so account details and tokens stay out of terminals and logs.
 * Returns true when every required agent is ready.
 */
export async function doctor({ root = process.cwd(), taskPath, json = false } = {}) {
  const path = resolve(root, taskPath || "tasks.json");
  let required = Object.keys(AGENTS);
  let registry = AGENTS;
  let scope = "all supported agents (no tasks.json found)";
  if (existsSync(path)) {
    const plan = await loadPlan(path, resolve(root));
    registry = plan.registry;
    required = [...new Set(plan.tasks.map(t => t.agent))];
    scope = `agents used in ${path}`;
  }
  if (!json) console.log(`Checking ${scope}:`);
  let ready = true;
  const agents = [];
  for (const key of required) {
    const def = registry[key];
    const bin = def.bin();
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15000 });
    if (probe.error) {
      ready = false;
      const reason = probe.error.code === "ENOENT" ? `\`${bin}\` not found on PATH` : probe.error.message;
      agents.push({ agent: key, label: def.label, binary: bin, installed: false, logged_in: false, status: "missing", reason });
      if (!json) console.log(`✗ ${key} (${def.label}) — ${reason}`);
      continue;
    }
    if (!def.auth) {
      agents.push({ agent: key, label: def.label, binary: bin, installed: true, logged_in: null, status: "unknown", reason: "login cannot be checked non-interactively" });
      if (!json) console.log(`! ${key} (${def.label}) — installed; login cannot be checked non-interactively. Run \`${bin}\` once to confirm you are signed in.`);
      continue;
    }
    const auth = spawnSync(bin, def.auth, { encoding: "utf8", timeout: 15000 });
    if (auth.error || auth.status !== 0) {
      ready = false;
      agents.push({ agent: key, label: def.label, binary: bin, installed: true, logged_in: false, status: "logged_out" });
      if (!json) console.log(`✗ ${key} (${def.label}) — installed but not logged in. Run \`${def.login}\`.`);
    } else {
      agents.push({ agent: key, label: def.label, binary: bin, installed: true, logged_in: true, status: "ready" });
      if (!json) console.log(`✓ ${key} (${def.label}) — installed and logged in`);
    }
  }
  if (json) console.log(JSON.stringify({ ready, scope, agents }, null, 2));
  else console.log(ready ? "\nAll required agents are ready." : "\nFix the agents marked ✗ before running tasks.");
  return ready;
}
