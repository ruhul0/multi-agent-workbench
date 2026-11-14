# tasks.json schema

`tasks.json` is either an array of tasks or an object `{ "plan": …, "tasks": [...], …settings }`. A JSON Schema for editors lives at `tasks.schema.json` in the package (`"$schema": "https://unpkg.com/multi-agent-workbench/tasks.schema.json"`).

## Task fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `id` | yes | — | Unique id, e.g. `L1`. Letters, digits, `.`, `_`, `-`. |
| `prompt` | yes | — | Exact instruction sent to the agent. Make it self-contained. |
| `owner` | yes* | agent name | Queue name. Tasks with the same owner run one after another. Letters, digits, `.`, `_`, `-`. |
| `command` | no | `owner` | Agent CLI: `claude`, `codex` (aliases `chatgpt`, `openai`), `agy` (alias `antigravity`) or a custom agent. *Either `owner` or `command` must name a known agent. |
| `task` | no | start of prompt | Short title shown in status and dashboard. |
| `isolate` | no | `false` | Run in its own worktree `../<repo>-<owner>-<id>` on branch `maw/<owner>-<id>`, in parallel with the owner's queue. |
| `worktree` | no | `../<repo>-<owner>` | Worktree path, relative to the git repository root (also when `maw` runs from a subdirectory). Created with `git worktree add` if missing. |
| `branch` | no | `maw/<owner>` | Branch checked out in the worktree. Created from `base` if missing. One branch can only be used by one worktree. |
| `base` | no | `HEAD` | Starting point for a new branch. `maw` warns when an existing branch is behind it. |
| `depends_on` | no | `[]` | Task ids that must be `done` first. If one fails, this task is `skipped`. |
| `check` | no | — | Shell command run in the worktree after the agent exits 0. Non-zero exit fails the task (or triggers a retry). |
| `check_timeout_minutes` | no | `30` | Time limit for `check`. |
| `retries` | no | `0` | Extra attempts (0–5). The failure (agent error, timeout or check output) is sent back to the agent; Claude Code and Codex continue their previous session. |
| `model` | no | CLI default | Model passed to the agent (`CLAUDE_MODEL`, `CODEX_MODEL`, `AGY_MODEL` env vars also work). |
| `effort` | no | CLI default | Reasoning effort (`CLAUDE_EFFORT`, `CODEX_EFFORT`, `AGY_EFFORT`). |
| `timeout_minutes` | no | `60` | The agent and everything it started are stopped after this long. |
| `max_cost_usd` | no | — | Spending cap for one task. Claude Code enforces it during the run; for other agents it stops further retries. |

## Run settings (object form only)

| Field | Meaning |
|---|---|
| `plan` | `{ "title", "summary", "source" }`, shown at the top of the dashboard. Written by `maw plan`. |
| `max_parallel` | Most tasks running at once (default: no limit). `maw run --max-parallel N` overrides it. |
| `budget_usd` | Once reported agent cost reaches this, no new tasks or retries start; the rest are `skipped`. |
| `agents` | Custom agent CLIs, see below. |
| `env` | `{ "allow": [...], "set": {...} }`. With `allow`, agents and checks only get basic variables (PATH, HOME, USER, SHELL, TERM, LANG, TMPDIR, …) plus those listed. `set` adds variables. Every agent also gets `MAW_TASK_ID`, `MAW_OWNER` and `MAW_BRANCH`. |
| `sandbox` | Command prefix that wraps every agent and check, e.g. `["docker", "run", "--rm", "-v", "{worktree}:{worktree}", "-w", "{worktree}", "image"]`. Placeholders: `{worktree}`, `{id}`, `{owner}`, `{root}`. |
| `notify` | `{ "desktop": true, "webhook": "https://…" }`. The webhook receives JSON with a Slack-compatible `text` field and per-task results. |

### Custom agents

```json
"agents": {
  "gemini": { "label": "Gemini CLI", "bin": "gemini", "args": ["--yolo", ["--model", "{model}"], "-p", "{prompt}"], "plan_args": ["-p", "{prompt}"], "auth": null, "login": "gemini", "aliases": ["google"] }
}
```

`args` must contain `{prompt}`. Strings have `{prompt}`, `{model}`, `{effort}`, `{id}` and `{worktree}` replaced; a nested array is an optional group dropped when any placeholder in it is empty. `plan_args` is the read-only call used by `maw plan` (defaults to `args`). `auth` is an argument list whose exit code 0 means logged in (`null`: cannot check). The binary can be overridden with `MAW_BIN_<NAME>`.

## Scheduling rules

- Each owner's queue runs in file order. Different owners, and isolated tasks, run in parallel (up to `max_parallel`).
- A task starts when its `depends_on` tasks are `done` and its worktree is free.
- If a queued task is `blocked`, the rest of that owner's queue is `skipped`, as are tasks depending on it. An isolated task failing does not stop the owner's queue.
- Dependencies that can never be met because of queue order (A1 waits for B2 while B1 waits for A2) are reported as a cycle before the run starts.
- `maw` exits 0 only if every task is `done`. Only one run per repository at a time.

## Task states and status record

States: `pending` → `running` → `done` | `blocked` | `skipped`.

Each entry in `.agent-workbench/status.json` → `tasks` records: `id`, `owner`, `agent`, `agent_label`, `task`, `prompt`, `worktree`, `branch`, `depends_on`, `isolate`, `state`, `attempt` / `attempts`, `base_commit`, `commit` (new `HEAD`, or `null` if no commit), `commits` (newest first: `sha`, `short`, `subject`, `time`, `author`, `files`, `insertions`, `deletions`), `files` (changed paths with git status letter, including uncommitted), `dirty`, `check` (`{ command, passed }`), `exit_code`, `reason`, `started_at`, `finished_at`, `usage` (`cost_usd`, `turns`, `input_tokens`, `output_tokens`) and the last 40 `output` lines. The top level also has `plan`, `usage` totals, `budget_usd` and `recent` events. Full output is in `.agent-workbench/logs/<id>.log`.

## Example

See `examples/orders.tasks.json` and `examples/custom-agent.tasks.json` in the package.
