---
name: multi-agent-workbench
description: Turn the user's plan into small micro-tasks, assign them to several coding agents (Claude Code, Codex, Antigravity or custom CLIs), and run them in parallel git worktrees with the `maw` supervisor, a live dashboard of progress, commits and diffs, then review and merge the results. Use when the user wants to split work between coding agents or run agents in parallel.
---

# Multi-agent workbench

You are the coordinator. The user owns the plan; you turn it into micro-tasks, start the `maw` supervisor, keep the user informed, and help review and merge. Worker agents do the implementation.

The flow is: **plan → micro-tasks → assign → run (dashboard) → review → merge**.

## 1. Preflight

1. The project must be a git repository with at least one commit. Check `git status`; uncommitted work in the main checkout is not seen by agents.
2. Check `maw` is available: `maw --version`, otherwise use `npx multi-agent-workbench` in place of `maw`.
3. Run `maw doctor`. Stop and tell the user about any agent marked ✗ (missing or not logged in). Agents marked `!` are installed but their login cannot be checked; mention it.
4. Tell the user before the first run that agents run with permission prompts disabled inside their worktrees.

## 2. The plan (the user's)

Ask for the plan, or help the user write one, in `PLAN.md` at the project root. A good plan states:

- the goal and what "done" looks like,
- the parts of the work (backend, frontend, data, tests, docs …),
- constraints and what is out of scope,
- how to verify it (test commands, lint, a URL to check).

Do not start splitting until the user agrees the plan is right.

## 3. Split into micro-tasks and assign agents

Run `maw plan PLAN.md` (add `--agents claude,codex` to limit who gets work, `--force` to replace an existing `tasks.json`). It asks a planner agent to read the plan and the repository, writes `tasks.json` with the plan title and summary, and validates it. You may also write `tasks.json` yourself; the rules are the same:

- One clear outcome per task, a handful of files, finishable in one agent run.
- Every task has an `owner` (which agent), a precise self-contained `prompt` ending with "Run the relevant tests and commit your changes with a clear message.", and where possible a `check` command that proves it works, with `retries: 1` so a failed check is sent back to the agent.
- Respect the user's assignment. Otherwise: Codex for frontend/integration, Claude for backend/data/refactors, Antigravity for QA/review.
- Tasks of one owner run in order on branch `maw/<owner>`. Use `depends_on` when a task needs another owner's work and say in the prompt which branch to merge first. Use `"isolate": true` for independent tasks that should run in parallel with the owner's queue.
- Avoid two owners editing the same files.
- For long or costly plans set `budget_usd` and `max_parallel`.

The full field list is in `references/task-schema.md`. Validate with `maw run --dry-run`, then show the user the task list (id, owner, title, dependencies) and wait for approval.

## 4. Run and keep the user informed

- Start `maw` (it blocks until the queues finish; run it in the background if your environment allows). The live dashboard opens at http://127.0.0.1:4317 — tell the user the URL. It shows the plan, each agent's current task and live output, what each agent will do next, every commit with its diff, changed files, cost, and buttons to stop or skip tasks. Use `--no-open` if they don't want a browser window, `--notify` for a desktop notification at the end.
- Read progress from `maw status` or `.agent-workbench/status.json`. Per-task logs: `.agent-workbench/logs/<id>.log`.
- Report to the user whenever a task finishes, is retried, fails, or is skipped.
- If a task is `blocked`, read its log, fix the prompt or split the task, then run `maw run --resume` (tasks already done are kept).

## 5. Review and merge

- `maw review` lists each task's commits, line counts, check result and leftover uncommitted changes. Inspect important commits with `git -C <worktree> show <sha>` or in the dashboard.
- `maw merge --check "<test command>"` merges finished work into a `maw/integration` worktree (stopping at the first conflict) and runs the tests on the merged result. Partial queues merge only the commits of tasks that finished.
- Never merge into the user's main branch or deploy without their approval. When they approve: `git merge --ff-only maw/integration` or a pull request from that branch.
- Summarize for the user: what each agent did, commits, test results, cost, and remaining risks.
- When done, `maw clean --branches` removes maw's worktrees and merged branches.

## Safety

`maw` runs every agent with permission prompts disabled (`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`) inside its worktree. Agents can run any command as the user. Only run it on repositories and machines where that is acceptable. To reduce exposure, set `env.allow` so agents only see the variables they need, and `sandbox` to run them in a container.
