import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, mkdir } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTasks } from "../multi-agent-workbench/scripts/tasks.mjs";

const MAW = fileURLToPath(new URL("../bin/maw.mjs", import.meta.url));

// A fake agent CLI: writes a file named after the prompt and commits it.
// Prompts containing "FAIL" exit 1; "NOCOMMIT" exits 0 without committing.
const FAKE_AGENT = `#!/bin/sh
prev=""; last=""; p=""
for a; do
  if [ "$prev" = "-p" ] || [ "$prev" = "--print" ]; then p="$a"; fi
  prev="$a"; last="$a"
done
[ -n "$p" ] && last="$p"
case "$last" in
  *FAIL*) echo "failing as asked" >&2; exit 1;;
  *NOCOMMIT*) echo "nothing to do"; exit 0;;
esac
name=$(printf '%s' "$last" | tr -c 'A-Za-z0-9' '_' | cut -c1-40)
echo "$last" > "$name.txt"
git add -A >/dev/null && git commit -qm "agent: $last"
echo "committed $name"
`;

async function setup(tasks) {
  const base = await mkdtemp(join(tmpdir(), "maw-test-"));
  const repo = join(base, "repo");
  await mkdir(repo);
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  await writeFile(join(repo, "README.md"), "x\n");
  git("add", "."); git("commit", "-qm", "init");
  const agent = join(base, "fake-agent.sh");
  await writeFile(agent, FAKE_AGENT);
  await chmod(agent, 0o755);
  await writeFile(join(repo, "tasks.json"), JSON.stringify(tasks));
  return { base, repo, agent };
}

function maw(cwd, agent, ...args) {
  return spawnSync(process.execPath, [MAW, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, MAW_BIN_CLAUDE: agent, MAW_BIN_CODEX: agent, MAW_BIN_AGY: agent, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

const statusOf = async (repo) => JSON.parse(await readFile(join(repo, ".agent-workbench/status.json"), "utf8"));

test("runs parallel queues in separate worktrees and records real commits", async () => {
  const { repo, agent } = await setup([
    { id: "L1", owner: "claude", prompt: "backend one" },
    { id: "L2", owner: "claude", prompt: "backend two" },
    { id: "C1", owner: "codex", prompt: "frontend one" },
    { id: "A1", owner: "antigravity", command: "agy", prompt: "qa pass", depends_on: ["L2", "C1"], check: "test -f qa_pass.txt" },
  ]);
  assert.match(maw(repo, agent, "--version").stdout, /^\d+\.\d+\.\d+/);
  const r = maw(repo, agent);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = await statusOf(repo);
  assert.deepEqual(s.tasks.map(t => t.state), ["done", "done", "done", "done"]);
  for (const t of s.tasks) assert.match(t.commit, /^[0-9a-f]{12}$/);
  const l2 = s.tasks.find(t => t.id === "L2");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: l2.worktree, encoding: "utf8" }).trim();
  assert.equal(head.slice(0, 12), l2.commit);
  assert.equal(s.tasks.find(t => t.id === "A1").check.passed, true);
  assert.notEqual(s.tasks[0].worktree, s.tasks[2].worktree);
});

test("failure stops that owner's queue and skips dependents; exit code is 1", async () => {
  const { repo, agent } = await setup([
    { id: "L1", owner: "claude", prompt: "please FAIL" },
    { id: "L2", owner: "claude", prompt: "never runs" },
    { id: "C1", owner: "codex", prompt: "independent" },
    { id: "C2", owner: "codex", prompt: "needs L1", depends_on: ["L1"] },
  ]);
  const r = maw(repo, agent);
  assert.equal(r.status, 1);
  const s = await statusOf(repo);
  const by = Object.fromEntries(s.tasks.map(t => [t.id, t]));
  assert.equal(by.L1.state, "blocked");
  assert.equal(by.L2.state, "skipped");
  assert.equal(by.C1.state, "done");
  assert.equal(by.C2.state, "skipped");
});

test("missing agent binary blocks the task instead of crashing", async () => {
  const { repo } = await setup([{ id: "L1", owner: "claude", prompt: "x" }]);
  const r = maw(repo, "/nonexistent/agent-binary");
  assert.equal(r.status, 1, r.stderr);
  const s = await statusOf(repo);
  assert.equal(s.tasks[0].state, "blocked");
  assert.match(s.tasks[0].reason, /not installed/);
});

test("failed acceptance check blocks the task", async () => {
  const { repo, agent } = await setup([{ id: "L1", owner: "claude", prompt: "NOCOMMIT", check: "exit 3" }]);
  const r = maw(repo, agent);
  assert.equal(r.status, 1);
  const s = await statusOf(repo);
  assert.equal(s.tasks[0].state, "blocked");
  assert.equal(s.tasks[0].commit, null);
  assert.match(s.tasks[0].reason, /check failed/);
});

test("init refuses to overwrite and --dry-run validates", async () => {
  const { repo, agent } = await setup([{ id: "L1", owner: "claude", prompt: "x" }]);
  assert.equal(maw(repo, agent, "init").status, 1);
  const dry = maw(repo, agent, "run", "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /L1\s+claude/);
});

test("validation catches bad tasks", () => {
  assert.throws(() => normalizeTasks([{ id: "a", owner: "bard", prompt: "x" }], "/r"), /unknown agent/);
  assert.throws(() => normalizeTasks([{ id: "a", owner: "claude", prompt: "x" }, { id: "a", owner: "codex", prompt: "y" }], "/r"), /duplicate id/);
  assert.throws(() => normalizeTasks([{ id: "a", owner: "claude", prompt: "x", depends_on: ["b"] }, { id: "b", owner: "codex", prompt: "y", depends_on: ["a"] }], "/r"), /cycle/);
  assert.throws(() => normalizeTasks([{ id: "a", owner: "claude", prompt: "x", depends_on: ["zzz"] }], "/r"), /unknown task/);
  const [t] = normalizeTasks([{ id: "a", owner: "chatgpt", prompt: "x" }], "/r/app");
  assert.equal(t.agent, "codex");
  assert.equal(t.worktree, "/r/app-chatgpt");
});
