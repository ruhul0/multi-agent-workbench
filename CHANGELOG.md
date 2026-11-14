# Changelog

## 0.3.0

### New

- **`maw plan`** turns a plan (`PLAN.md`, any file, or a one-line goal) into validated micro-tasks assigned to the available agents, and records the plan's title and summary.
- **Retries with feedback.** `retries` sends a failed check, agent error or timeout back to the agent; Claude Code and Codex continue their previous session.
- **`maw review`**, **`maw merge`** (into a `maw/integration` worktree, with `--check`, `--only`, `--into-current`) and **`maw clean`**.
- **Dashboard:** plan header, per-agent "up next" queue and commits, commit history across agents with a diff viewer, changed files per task, attempts, cost, and stop/skip buttons.
- **Isolated tasks** (`isolate: true`) and `max_parallel` / `--max-parallel`.
- **Custom agents** via argv templates in `tasks.json`.
- **Cost tracking** from Claude Code and Codex; `budget_usd` per run and `max_cost_usd` per task.
- **Safety options:** `env.allow` / `env.set`, a `sandbox` command prefix.
- **Notifications:** `--notify` / `notify.desktop` and `notify.webhook`.
- `maw run --resume` keeps tasks finished in the previous run.
- Codex runs with `--json`, so its output is readable and its usage is tracked.
- `tasks.schema.json` for editor autocomplete, `examples/`, and a Claude Code plugin manifest.

### Fixed

- Timeouts and Ctrl+C now stop the agent's whole process tree (tool calls, test runners); a run no longer hangs when a background process keeps output open. A second Ctrl+C force-quits.
- Running from a subdirectory no longer creates worktrees inside the repository.
- Unknown or mistyped flags are rejected instead of starting a run.
- Codex prompts starting with `-` are no longer read as flags.
- The dashboard rejects requests for other host names (DNS rebinding) and requires a token for actions.
- Validation catches unsafe ids and owners, non-string prompts, non-positive timeouts, one branch used by two worktrees, and deadlocks caused by queue order.
- Only one run per repository at a time; `.agent-workbench/` is added to `.git/info/exclude`.
- Status write failures are reported instead of ignored; very long output lines are truncated.

### Changed

- The skill moved to `skills/multi-agent-workbench/` (plugin layout).
- `status.json` `commits` entries are objects (`sha`, `subject`, `time`, line counts) instead of strings.
- `check` timeout is configurable (`check_timeout_minutes`, default 30).
