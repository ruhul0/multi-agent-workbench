---
name: multi-agent-workbench
description: Split a software task into small, owned micro-tasks and run them in parallel across Claude Code, Codex and Antigravity CLIs using the `maw` supervisor (isolated git worktrees, dependencies, acceptance checks, live status). Use when the user asks to divide work between several coding agents or to run agents in parallel.
---

# Multi-agent workbench

You are the coordinator. You plan, write `tasks.json`, start the `maw` supervisor, watch progress, and review results. The worker agents do the implementation.

## 1. Preflight

1. Confirm the project is a git repository with at least one commit and a clean working tree (`git status`).
2. Check `maw` is available: `maw --version`, otherwise use `npx multi-agent-workbench`.
3. Run `maw doctor`. Stop and tell the user about any agent marked ✗ (missing or not logged in). Agents marked `!` are installed but their login cannot be checked; mention it.

## 2. Plan micro-tasks

- Keep each task small: one outcome, a handful of files, finishable in one agent run.
- Give every task an `owner`, a precise `prompt`, and, where possible, a `check` command that proves it works (for example `npm test -- auth`).
- Use the user's requested assignment. If none is given, a sensible default is Codex for frontend/integration, Claude for backend/data, Antigravity for QA/review.
- Tasks for one owner run in order in that owner's worktree. Use `depends_on` when a task needs another owner's work; make the prompt say which branch to merge or inspect (each owner works on branch `maw/<owner>`).
- Every prompt should end with: "Run the relevant tests and commit your changes with a clear message."
- Avoid two owners editing the same files at the same time.

The full field list is in `references/task-schema.md`. Validate the plan with `maw run --dry-run`, show it to the user, and wait for approval before running.

## 3. Run and monitor

- Start `maw` (it blocks until all queues finish; run it in the background if your environment allows). It opens a live dashboard in the user's browser at http://127.0.0.1:4317; tell them the URL. Use `--no-open` if they don't want a browser window.
- Read progress from `.agent-workbench/status.json` or `maw status`.
- Report to the user whenever a task finishes, fails, or is skipped. Per-task logs are in `.agent-workbench/logs/<id>.log`.
- If a task is `blocked`, read its log, fix the prompt or split it, and re-run with a new `tasks.json` containing only the remaining work.

## 4. Review and integrate

- Never merge or deploy unreviewed work. For each `done` task, inspect the commit (`git -C <worktree> show <commit>`), run the project's tests, then merge or cherry-pick into the main branch.
- Note tasks that finished "without a new commit" or with uncommitted changes; they need follow-up.
- Summarize for the user: what each agent did, commits, test results, and remaining risks.

## Safety

`maw` runs every agent with permission prompts disabled (`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`) inside its worktree. Only run it on repositories and machines where that is acceptable, and say so to the user before the first run.
