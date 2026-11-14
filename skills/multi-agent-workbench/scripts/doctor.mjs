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
export async function doctor({ root = process.cwd(), taskPath, json = false, deep = false } = {}) {
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
    let entry;
    if (!def.auth) {
      entry = { agent: key, label: def.label, binary: bin, installed: true, logged_in: null, status: "unknown", reason: "login cannot be checked non-interactively" };
    } else {
      const auth = spawnSync(bin, def.auth, { encoding: "utf8", timeout: 15000 });
      if (auth.error || auth.status !== 0) {
        ready = false;
        agents.push({ agent: key, label: def.label, binary: bin, installed: true, logged_in: false, status: "logged_out" });
        if (!json) console.log(`✗ ${key} (${def.label}) — installed but not logged in. Run \`${def.login}\`.`);
        continue;
      }
      entry = { agent: key, label: def.label, binary: bin, installed: true, logged_in: true, status: "ready" };
    }
    if (deep) {
      // A real (tiny, read-only) request catches problems a login check cannot, such as a
      // default model the account is not allowed to use.
      const tty = !json && process.stdout.isTTY;
      if (tty) process.stdout.write(`  … asking ${key} for a one-word reply`);
      const test = spawnSync(bin, def.planArgs("Reply with the single word ok."), { encoding: "utf8", timeout: 180_000, cwd: root });
      const answered = !test.error && test.status === 0 && /\bok\b/i.test(test.stdout || "");
      if (tty) process.stdout.write("\r\x1b[2K");
      entry.responds = answered;
      if (answered) {
        entry.status = "ready";
        if (entry.logged_in === null) entry.logged_in = true;
        delete entry.reason;
      } else {
        ready = false;
        entry.status = "not_responding";
        entry.reason = test.error?.code === "ETIMEDOUT" ? "no reply within 3 minutes" : lastLine(`${test.stderr || ""}\n${test.stdout || ""}`) || `exit ${test.status}`;
      }
    }
    agents.push(entry);
    if (json) continue;
    if (entry.status === "not_responding") console.log(`✗ ${key} (${def.label}) — installed${entry.logged_in ? " and logged in" : ""}, but a test request failed: ${entry.reason}`);
    else if (entry.status === "unknown") console.log(`! ${key} (${def.label}) — installed; login cannot be checked non-interactively. Run \`${bin}\` once (or \`maw doctor --deep\`) to confirm you are signed in.`);
    else console.log(`✓ ${key} (${def.label}) — installed and logged in${deep ? ", answered a test request" : ""}`);
  }
  if (json) console.log(JSON.stringify({ ready, scope, agents }, null, 2));
  else console.log(ready ? "\nAll required agents are ready." : "\nFix the agents marked ✗ before running tasks.");
  return ready;
}

/** Last meaningful line of CLI output, with e-mail addresses removed. */
function lastLine(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const pick = [...lines].reverse().find(l => /error|not supported|unauthor|denied|invalid|failed/i.test(l)) || lines.at(-1) || "";
  return pick.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>").slice(0, 300);
}
