import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AGENTS } from "./agents.mjs";
import { loadTasks } from "./tasks.mjs";

/**
 * Check that each agent CLI is installed and logged in. Never prints CLI output,
 * so account details and tokens stay out of terminals and logs.
 * Returns true when every required agent is ready.
 */
export async function doctor({ root = process.cwd(), taskPath } = {}) {
  const path = resolve(root, taskPath || "tasks.json");
  let required = Object.keys(AGENTS);
  let scope = "all supported agents (no tasks.json found)";
  if (existsSync(path)) {
    const tasks = await loadTasks(path, resolve(root));
    required = [...new Set(tasks.map(t => t.agent))];
    scope = `agents used in ${path}`;
  }
  console.log(`Checking ${scope}:`);
  let ready = true;
  for (const key of required) {
    const def = AGENTS[key];
    const bin = def.bin();
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15000 });
    if (probe.error) {
      ready = false;
      console.log(`✗ ${key} (${def.label}) — ${probe.error.code === "ENOENT" ? `\`${bin}\` not found on PATH` : probe.error.message}`);
      continue;
    }
    if (!def.auth) {
      console.log(`! ${key} (${def.label}) — installed; login cannot be checked non-interactively. Run \`${bin}\` once to confirm you are signed in.`);
      continue;
    }
    const auth = spawnSync(bin, def.auth, { encoding: "utf8", timeout: 15000 });
    if (auth.error || auth.status !== 0) {
      ready = false;
      console.log(`✗ ${key} (${def.label}) — installed but not logged in. Run \`${bin} ${key === "claude" ? "auth login" : "login"}\`.`);
    } else {
      console.log(`✓ ${key} (${def.label}) — installed and logged in`);
    }
  }
  console.log(ready ? "\nAll required agents are ready." : "\nFix the agents marked ✗ before running tasks.");
  return ready;
}
