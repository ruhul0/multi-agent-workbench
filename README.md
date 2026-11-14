# Multi-Agent Workbench

[![npm](https://img.shields.io/npm/v/multi-agent-workbench)](https://www.npmjs.com/package/multi-agent-workbench) [![CI](https://github.com/ruhul0/multi-agent-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/ruhul0/multi-agent-workbench/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/multi-agent-workbench)](LICENSE)

Run Claude Code, Codex and Antigravity CLIs in parallel. Each agent works in its own git worktree, takes small tasks from its own queue, and reports commits, check results and output to a live status file and dashboard.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/ruhul0/multi-agent-workbench/main/docs/dashboard-dark.png">
  <img alt="maw live dashboard: agent cards with live output, task board by state, and activity timeline" src="https://raw.githubusercontent.com/ruhul0/multi-agent-workbench/main/docs/dashboard-light.png">
</picture>

> **Warning:** `maw` starts agents with their permission prompts disabled (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`). They can run any command as your user. Only use it on repositories and machines where that is acceptable, and review every commit before merging.

## Requirements

- Node.js 20 or newer
- A git repository with at least one commit
- At least one agent CLI, logged in: [`claude`](https://docs.claude.com/en/docs/claude-code), [`codex`](https://github.com/openai/codex) or `agy` (Antigravity)

## Quick start

```bash
npm install -g multi-agent-workbench
cd your-project
maw init            # writes a starter tasks.json
# edit tasks.json
maw doctor          # are the agents installed and logged in?
maw run --dry-run   # validate the plan
maw                 # run it; the live dashboard opens in your browser
```

Without installing: `npx multi-agent-workbench <command>`.

## tasks.json

```json
[
  { "id": "L1", "owner": "claude", "task": "Orders API", "prompt": "Add GET /api/orders with pagination. Run the API tests and commit.", "check": "npm test -- orders" },
  { "id": "C1", "owner": "codex", "task": "Orders page", "prompt": "Build the orders page. Run lint and commit." },
  { "id": "A1", "owner": "antigravity", "command": "agy", "task": "QA", "depends_on": ["L1", "C1"], "prompt": "Merge maw/claude and maw/codex into this branch, run all tests, fix only clear bugs, and commit." }
]
```

- Each **owner** has a queue. Queues run in parallel; tasks in one queue run in order.
- Each owner gets a worktree at `../<repo>-<owner>` on branch `maw/<owner>`, created automatically. Override with `worktree`, `branch` and `base`.
- `depends_on` waits for other tasks; if one fails, dependents are skipped.
- `check` is a shell command run after the agent finishes. If it fails, the task is blocked.
- If a task is blocked, the rest of that owner's queue is skipped.
- `model`, `effort` and `timeout_minutes` can be set per task (or with `CLAUDE_MODEL`, `CODEX_MODEL`, `AGY_MODEL` and the matching `*_EFFORT` env vars).

Full field reference: [`multi-agent-workbench/references/task-schema.md`](multi-agent-workbench/references/task-schema.md).

## Commands

| Command | What it does |
|---|---|
| `maw init [--force]` | Create a starter `tasks.json`. Won't overwrite without `--force`. |
| `maw doctor` | Check the agents used in `tasks.json` (or all agents) are installed and logged in. Exits 1 if any are not. Never prints account details. |
| `maw` / `maw run` | Run the queues and open the live dashboard. Exits 0 only if every task is done. `--dry-run` validates and prints the plan; `--no-open` serves the dashboard without opening a browser; `--no-dashboard` skips it. |
| `maw status` | Summarize the last run. |
| `maw dashboard [--port N]` | Open the status page on its own, e.g. to review a finished run. |
| `maw install-skill` | Install the planning skill for Codex and Claude Code (`--codex` / `--claude` for one). |

All commands accept `--tasks <file>` to use a different task file.

## Live dashboard

`maw` starts a status page at http://127.0.0.1:4317 (or the next free port) and opens it in your browser. It refreshes every 2 seconds and shows:

- each agent's current task, state, latest commit and last 30 lines of output
- every task's state, owner, commit, check result and why it was skipped or blocked
- recent supervisor events

When the run finishes, the page stays up for review until you press Ctrl+C. In scripts and CI (no terminal attached) `maw` exits as soon as the run ends, and the browser is not opened when `CI` is set.

## Output

- `.agent-workbench/status.json`: every task's state, real commit (read from git, not guessed from output), new commits, uncommitted changes, check result and last 30 lines of output
- `.agent-workbench/logs/<id>.log`: full output per task
- `.agent-workbench/supervisor.log`: event log

Add `.agent-workbench/` to your project's `.gitignore`.

## Use as a skill

The skill tells a coordinating agent how to plan micro-tasks, write `tasks.json`, run `maw` and review the results.

```bash
maw install-skill
```

This copies the skill to `~/.codex/skills/multi-agent-workbench` and `~/.claude/skills/multi-agent-workbench`. Then ask:

- Codex: `Use $multi-agent-workbench to split this into micro-tasks: frontend to Codex, backend to Claude, QA to Antigravity.`
- Claude Code: `/multi-agent-workbench split this into micro-tasks …`

## Development

```bash
npm test        # end-to-end tests with a fake agent CLI
npm run check   # syntax check
```

## License

MIT
