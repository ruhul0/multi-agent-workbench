#!/usr/bin/env node
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFile } from "node:fs/promises";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supervisor = resolve(packageRoot, "multi-agent-workbench/scripts/supervisor.mjs");
const command = process.argv[2];
if (command === "--help" || command === "-h") {
  console.log("multi-agent-workbench — run Claude and Codex tasks in parallel");
  console.log("\nCommands:\n  maw init    Create a starter tasks.json\n  maw doctor Check agent CLIs and authentication\n  maw         Run the task queue in the current project");
  process.exit(0);
}
if (command === "doctor") {
  const checks = [
    ["claude", ["auth", "status"]],
    ["codex", ["login", "status"]],
    ["agy", ["--help"]],
  ];
  for (const [name, args] of checks) {
    const result = spawnSync(name, args, { encoding: "utf8", timeout: 10000 });
    const installed = !result.error;
    const output = `${result.stdout || ""}${result.stderr || ""}`.replace(/token[^\n]*/gi, "token [redacted]").trim();
    console.log(`${installed ? "✓" : "✗"} ${name}${installed ? ` — ${output.split("\n")[0] || "available"}` : " — not installed"}`);
  }
  process.exit(0);
}
if (command === "init") {
  const target = resolve(process.cwd(), "tasks.json");
  await writeFile(target, JSON.stringify([
    { id: "L1", owner: "claude", command: "claude", worktree: "../project-claude", task: "Backend task", prompt: "Implement the backend task and commit it." },
    { id: "C1", owner: "codex", command: "codex", worktree: "../project-codex", task: "Frontend task", prompt: "Implement the frontend task and commit it." },
    { id: "A1", owner: "antigravity", command: "agy", worktree: "../project-agy", task: "QA task", prompt: "Audit the current changes, fix only clear issues, and commit them." }
  ], null, 2) + "\n", { flag: "wx" });
  console.log(`Created ${target}. Edit it, then run maw.`);
  process.exit(0);
}
const child = spawn(process.execPath, [supervisor, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
