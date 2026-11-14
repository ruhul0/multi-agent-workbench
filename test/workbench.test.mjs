import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, mkdir } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTasks } from "../skills/multi-agent-workbench/scripts/tasks.mjs";
import { formatClaudeEvent, formatCodexEvent, parseCodexEvent, parseClaudeEvent, expandTemplate, AGENTS } from "../skills/multi-agent-workbench/scripts/agents.mjs";
import { dashboard } from "../skills/multi-agent-workbench/scripts/dashboard.mjs";
import { request } from "node:http";
import { spawn } from "node:child_process";

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
  *SLOW*) echo "working on it"; sleep 3; echo "done";;
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
    env: { ...process.env, MAW_NO_DASHBOARD: "1", MAW_BIN_CLAUDE: agent, MAW_BIN_CODEX: agent, MAW_BIN_AGY: agent, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
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

test("run serves the dashboard and exits when not attached to a terminal", async () => {
  const { repo, agent } = await setup([{ id: "L1", owner: "claude", prompt: "dash check" }]);
  const port = String(40000 + Math.floor(Math.random() * 20000));
  const r = spawnSync(process.execPath, [MAW, "--port", port], {
    cwd: repo, encoding: "utf8", timeout: 30000,
    env: { ...process.env, CI: "1", MAW_BIN_CLAUDE: agent, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /live dashboard at http:\/\/127\.0\.0\.1:\d+/);
});

test("agent output reaches status.json while the task is still running", async () => {
  const { repo, agent } = await setup([{ id: "L1", owner: "claude", prompt: "SLOW NOCOMMIT" }]);
  const child = spawn(process.execPath, [MAW], { cwd: repo, env: { ...process.env, MAW_NO_DASHBOARD: "1", MAW_BIN_CLAUDE: agent }, stdio: "ignore" });
  const exited = new Promise(r => child.on("close", r));
  let seen = false;
  for (let i = 0; i < 25 && !seen; i++) {
    await new Promise(r => setTimeout(r, 100));
    try {
      const s = await statusOf(repo);
      seen = s.tasks[0].state === "running" && s.tasks[0].output.includes("working on it");
    } catch {}
  }
  await exited;
  assert.ok(seen, "live output was not written to status.json during the run");
});

test("claude stream-json events become readable lines", () => {
  const ev = (o) => formatClaudeEvent(JSON.stringify(o));
  assert.deepEqual(ev({ type: "system", subtype: "init" }), []);
  assert.deepEqual(ev({ type: "assistant", message: { content: [{ type: "text", text: "Plan:\nstep one" }, { type: "tool_use", name: "Bash", input: { command: "npm test" } }] } }), ["Plan:", "step one", "▸ Bash: npm test"]);
  assert.deepEqual(ev({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "boom\nmore" }] } }), ["  ✕ boom"]);
  assert.deepEqual(ev({ type: "result", subtype: "success", num_turns: 4 }), ["✓ finished in 4 turns"]);
  assert.deepEqual(formatClaudeEvent("plain text"), ["plain text"]);
});

test("timeout stops the agent's whole process tree promptly", async () => {
  const { repo, base } = await setup([{ id: "L1", owner: "claude", prompt: "x", timeout_minutes: 0.03 }]);
  // The agent leaves a background child holding stdout, like a tool call or test runner would.
  const agent = join(base, "hang.sh");
  await writeFile(agent, "#!/bin/sh\nsleep 30 &\nsleep 30\n");
  await chmod(agent, 0o755);
  const started = Date.now();
  const r = maw(repo, agent);
  const elapsed = Date.now() - started;
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.ok(elapsed < 15000, `run took ${elapsed}ms after a ~2s timeout`);
  const s = await statusOf(repo);
  assert.match(s.tasks[0].reason, /timed out/);
});

test("running from a subdirectory keeps worktrees and state outside the repo", async () => {
  const { repo, agent } = await setup([{ id: "L1", owner: "claude", prompt: "sub run" }]);
  const sub = join(repo, "packages", "app");
  await mkdir(sub, { recursive: true });
  await writeFile(join(sub, "tasks.json"), JSON.stringify([{ id: "L1", owner: "claude", prompt: "sub run" }]));
  const r = maw(sub, agent);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = await statusOf(repo);
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim();
  assert.ok(!s.tasks[0].worktree.startsWith(top + "/"), `worktree ${s.tasks[0].worktree} is inside the repo`);
  assert.equal(maw(sub, agent, "status").status, 0);
});

test("unknown flags are rejected instead of starting a run", async () => {
  const { repo, agent } = await setup([{ id: "L1", owner: "claude", prompt: "x" }]);
  const r = maw(repo, agent, "--dryrun");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown option '--dryrun'/);
  await assert.rejects(statusOf(repo));
});

test("codex prompts starting with a dash are passed after --", () => {
  const args = AGENTS.codex.args({ prompt: "-fix the build" });
  assert.deepEqual(args.slice(-2), ["--", "-fix the build"]);
});

// ---- 0.3 features ----

async function script(base, name, body) {
  const p = join(base, name);
  await writeFile(p, `#!/bin/sh\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

test("a failed check is sent back to the agent and the retry can pass", async () => {
  const { repo, base } = await setup([{ id: "L1", owner: "codex", prompt: "build it", check: "test -f fixed.txt", retries: 1 }]);
  // First attempt commits nothing useful; when the prompt carries the check failure it fixes it.
  const agent = await script(base, "learner.sh", `for a; do last="$a"; done
case "$last" in *"acceptance check"*) echo ok > fixed.txt; git add -A; git commit -qm "fix: make check pass";; *) echo first > first.txt; git add -A; git commit -qm "first try";; esac`);
  const r = maw(repo, agent);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = await statusOf(repo);
  assert.equal(s.tasks[0].state, "done");
  assert.equal(s.tasks[0].attempt, 2);
  assert.equal(s.tasks[0].commits.length, 2);
  assert.equal(s.tasks[0].commits[0].subject, "fix: make check pass");
  assert.ok(s.tasks[0].files.some(f => f.path === "fixed.txt"));
});

test("isolated tasks run in their own worktrees and max_parallel limits concurrency", async () => {
  const { repo, agent } = await setup({ max_parallel: 1, tasks: [
    { id: "L1", owner: "claude", prompt: "iso one", isolate: true },
    { id: "L2", owner: "claude", prompt: "iso two", isolate: true },
  ] });
  const r = maw(repo, agent);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = await statusOf(repo);
  assert.notEqual(s.tasks[0].worktree, s.tasks[1].worktree);
  assert.equal(s.tasks[0].branch, "maw/claude-L1");
  // with max_parallel 1 the second task starts after the first finished
  assert.ok(new Date(s.tasks[1].started_at) >= new Date(s.tasks[0].finished_at));
});

test("custom agents are defined with argv templates", async () => {
  const { repo, agent } = await setup({
    agents: { mybot: { bin: "mybot", args: ["--yolo", ["--model", "{model}"], "{prompt}"] } },
    tasks: [{ id: "M1", owner: "mybot", prompt: "custom agent work" }],
  });
  const r = spawnSync(process.execPath, [MAW], { cwd: repo, encoding: "utf8", env: { ...process.env, MAW_NO_DASHBOARD: "1", MAW_BIN_MYBOT: agent } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal((await statusOf(repo)).tasks[0].state, "done");
  assert.deepEqual(expandTemplate(["--yolo", ["--model", "{model}"], "{prompt}"], { prompt: "p" }), ["--yolo", "p"]);
});

test("--resume keeps tasks finished in the previous run", async () => {
  const { repo, agent } = await setup([
    { id: "L1", owner: "claude", prompt: "first part" },
    { id: "L2", owner: "claude", prompt: "second part FAIL" },
  ]);
  assert.equal(maw(repo, agent).status, 1);
  const tasks = JSON.parse(await readFile(join(repo, "tasks.json"), "utf8"));
  tasks[1].prompt = "second part fixed";
  await writeFile(join(repo, "tasks.json"), JSON.stringify(tasks));
  const r = maw(repo, agent, "--resume");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = await statusOf(repo);
  assert.equal(s.tasks[0].reason, "done in an earlier run");
  assert.equal(s.tasks[1].state, "done");
});

test("validation: queue-order deadlocks, shared branches, bad fields", () => {
  assert.throws(() => normalizeTasks([
    { id: "A1", owner: "claude", prompt: "x", depends_on: ["B2"] }, { id: "A2", owner: "claude", prompt: "x" },
    { id: "B1", owner: "codex", prompt: "x", depends_on: ["A2"] }, { id: "B2", owner: "codex", prompt: "x" },
  ], "/r"), /cycle/);
  assert.throws(() => normalizeTasks([{ id: "a", owner: "claude", prompt: "x", branch: "same" }, { id: "b", owner: "codex", prompt: "y", branch: "same" }], "/r"), /already checked out/);
  assert.throws(() => normalizeTasks([{ id: "a", owner: "claude", prompt: "x", timeout_minutes: -1 }], "/r"), /positive/);
  assert.throws(() => normalizeTasks([{ id: "a", owner: "claude", prompt: 42 }], "/r"), /non-empty string/);
  assert.throws(() => normalizeTasks([{ id: "a b", owner: "claude", prompt: "x" }], "/r"), /"id" may only/);
  assert.throws(() => normalizeTasks([{ id: "a", owner: "../evil", command: "claude", prompt: "x" }], "/r"), /"owner" may only/);
});

test("a second run in the same repository is refused while one is active", async () => {
  const { repo, agent } = await setup([{ id: "L1", owner: "claude", prompt: "SLOW NOCOMMIT" }]);
  const env = { ...process.env, MAW_NO_DASHBOARD: "1", MAW_BIN_CLAUDE: agent };
  const first = spawn(process.execPath, [MAW], { cwd: repo, env, stdio: "ignore" });
  const exited = new Promise(r => first.on("close", r));
  await new Promise(r => setTimeout(r, 800));
  const second = spawnSync(process.execPath, [MAW], { cwd: repo, env, encoding: "utf8" });
  await exited;
  assert.equal(second.status, 2);
  assert.match(second.stderr, /already running/);
});

test("maw plan turns a plan file into validated tasks", async () => {
  const { repo, base } = await setup([{ id: "x", owner: "claude", prompt: "x" }]);
  await writeFile(join(repo, "PLAN.md"), "# Orders feature\nAdd an orders API and page.\n");
  const answer = JSON.stringify({ plan: { title: "Orders", summary: "API then UI." }, tasks: [
    { id: "L1", owner: "claude", task: "API", prompt: "Build the API. Run the relevant tests and commit your changes with a clear message." },
    { id: "C1", owner: "codex", task: "UI", prompt: "Build the UI.", depends_on: ["L1"] },
  ] });
  const planner = await script(base, "planner.sh", `cat <<'JSON'\nHere is the plan:\n\`\`\`json\n${answer}\n\`\`\`\nJSON`);
  const env = { ...process.env, MAW_BIN_CLAUDE: planner, MAW_BIN_CODEX: planner };
  assert.equal(spawnSync(process.execPath, [MAW, "plan"], { cwd: repo, env, encoding: "utf8" }).status, 2, "refuses to overwrite tasks.json");
  const r = spawnSync(process.execPath, [MAW, "plan", "--force", "--agents", "claude,codex"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const written = JSON.parse(await readFile(join(repo, "tasks.json"), "utf8"));
  assert.equal(written.plan.title, "Orders");
  assert.equal(written.plan.source, "PLAN.md");
  assert.deepEqual(written.tasks.map(t => t.id), ["L1", "C1"]);
});

test("review, merge into an integration worktree, and clean", async () => {
  const { repo, agent } = await setup([
    { id: "L1", owner: "claude", prompt: "backend change" },
    { id: "C1", owner: "codex", prompt: "frontend change" },
    { id: "C2", owner: "codex", prompt: "broken FAIL" },
  ]);
  assert.equal(maw(repo, agent).status, 1);
  const rev = JSON.parse(maw(repo, agent, "review", "--json").stdout);
  assert.equal(rev.tasks.find(t => t.id === "L1").commits.length, 1);
  const m = maw(repo, agent, "merge", "--check", "test -f backend_change.txt && test -f frontend_change.txt");
  assert.equal(m.status, 0, m.stderr + m.stdout);
  assert.match(m.stdout, /not merged: C2/);
  const integration = join(repo, "..", "repo-integration");
  const log = execFileSync("git", ["log", "--format=%s"], { cwd: integration, encoding: "utf8" });
  assert.match(log, /Merge maw\/claude/);
  assert.match(log, /Merge maw\/codex/);
  const c = maw(repo, agent, "clean", "--branches", "--force");
  assert.equal(c.status, 0, c.stderr + c.stdout);
  assert.doesNotMatch(execFileSync("git", ["branch"], { cwd: repo, encoding: "utf8" }), /maw\//);
});

test("dashboard rejects foreign Host headers and cross-site actions, serves diffs", async () => {
  const { repo, agent } = await setup([{ id: "L1", owner: "claude", prompt: "diff me" }]);
  assert.equal(maw(repo, agent).status, 0);
  const control = { stopTask: () => true };
  const { server, url } = await dashboard({ root: repo, port: 40000 + Math.floor(Math.random() * 20000), control });
  try {
    const port = new URL(url).port;
    const raw = (path, headers = {}, method = "GET") => new Promise((done, fail) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => { let b = ""; res.on("data", c => b += c); res.on("end", () => done({ status: res.statusCode, body: b })); });
      req.on("error", fail); req.end();
    });
    assert.equal((await raw("/status.json", { host: `evil.example:${port}` })).status, 421);
    assert.equal((await raw("/status.json")).status, 200);
    assert.equal((await raw("/api/stop", {}, "POST")).status, 403);
    const page = await raw("/");
    const token = page.body.match(/"token":"([0-9a-f]+)"/)[1];
    assert.equal((await raw("/api/stop", { "x-maw-token": token, "content-type": "application/json" }, "POST")).status, 200);
    const sha = (await statusOf(repo)).tasks[0].commits[0].sha;
    assert.match((await raw(`/api/diff?task=L1&sha=${sha}`)).body, /\+diff me/);
    assert.match((await raw(`/api/diff?task=L1&sha=deadbeef`)).body, /does not belong/);
  } finally {
    server.close();
  }
});

test("codex --json events become readable lines and usage", () => {
  const ev = (o) => formatCodexEvent(JSON.stringify(o));
  assert.deepEqual(ev({ type: "item.started", item: { type: "command_execution", command: "npm test" } }), ["▸ npm test"]);
  assert.deepEqual(ev({ type: "item.completed", item: { type: "agent_message", text: "All done" } }), ["All done"]);
  assert.deepEqual(ev({ type: "item.completed", item: { type: "file_change", changes: [{ path: "a.js", kind: "update" }] } }), ["▸ update a.js"]);
  assert.deepEqual(ev({ type: "turn.failed", error: { message: "model not supported" } }), ["✕ model not supported"]);
  assert.deepEqual(parseCodexEvent(JSON.stringify({ type: "thread.started", thread_id: "t1" })), { session_id: "t1" });
  assert.equal(parseClaudeEvent(JSON.stringify({ type: "result", session_id: "s", total_cost_usd: 0.5, num_turns: 3 })).usage.cost_usd, 0.5);
  const resumeArgs = AGENTS.codex.args({ prompt: "p" }, { prompt: "fix it", resume: "t1" });
  assert.deepEqual([resumeArgs[0], resumeArgs[1], ...resumeArgs.slice(-3)], ["exec", "resume", "--", "t1", "fix it"]);
});

test("budget stops new tasks; env.allow keeps other variables away from agents", async () => {
  const { repo, base } = await setup({ budget_usd: 0.5, env: { allow: [], set: { MAW_TEST_SET: "yes" } }, tasks: [
    { id: "L1", owner: "claude", prompt: "spend" },
    { id: "L2", owner: "claude", prompt: "never" },
  ] });
  const agent = await script(base, "spender.sh", `env > "$PWD/../agent-env.txt"
echo '{"type":"result","subtype":"success","session_id":"s1","total_cost_usd":1.25,"num_turns":2}'`);
  const r = spawnSync(process.execPath, [MAW], { cwd: repo, encoding: "utf8", env: { ...process.env, MAW_NO_DASHBOARD: "1", MAW_BIN_CLAUDE: agent, MAW_TEST_SECRET: "hidden" } });
  assert.equal(r.status, 1, r.stderr + r.stdout);
  const s = await statusOf(repo);
  assert.equal(s.usage.cost_usd, 1.25);
  assert.equal(s.tasks[1].state, "skipped");
  assert.match(s.tasks[1].reason, /budget/);
  const env = await readFile(join(base, "agent-env.txt"), "utf8");
  assert.match(env, /MAW_TEST_SET=yes/);
  assert.match(env, /MAW_TASK_ID=L1/);
  assert.doesNotMatch(env, /MAW_TEST_SECRET/);
});

test("bundled examples and the starter file are valid", async () => {
  const { parsePlan } = await import("../skills/multi-agent-workbench/scripts/tasks.mjs");
  for (const f of ["orders.tasks.json", "custom-agent.tasks.json"]) {
    const data = JSON.parse(await readFile(new URL(`../examples/${f}`, import.meta.url), "utf8"));
    assert.ok(parsePlan(data, "/r/app").tasks.length > 0, f);
  }
  const { repo, agent } = await setup([{ id: "x", owner: "claude", prompt: "x" }]);
  assert.equal(maw(repo, agent, "init", "--force").status, 0);
  assert.equal(maw(repo, agent, "run", "--dry-run").status, 0);
});
