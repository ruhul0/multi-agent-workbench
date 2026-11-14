#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFile } from "node:fs/promises";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supervisor = resolve(packageRoot, "multi-agent-workbench/scripts/supervisor.mjs");
const command = process.argv[2];
if (command === "--help" || command === "-h") {
  console.log("multi-agent-workbench — run Claude and Codex tasks in parallel");
  console.log("\nCommands:\n  maw init    Create a starter tasks.json\n  maw         Run the task queue in the current project");
  process.exit(0);
}
if (command === "init") {
  const target = resolve(process.cwd(), "tasks.json");
  await writeFile(target, JSON.stringify([
    { id: "L1", owner: "claude", worktree: "../project-claude", task: "Backend task", prompt: "Implement the backend task and commit it." },
    { id: "C1", owner: "codex", worktree: "../project-codex", task: "Frontend task", prompt: "Implement the frontend task and commit it." }
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
