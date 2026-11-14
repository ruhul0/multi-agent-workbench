# tasks.json schema

`tasks.json` is either an array of tasks or an object `{ "tasks": [...] }`.

| Field | Required | Default | Meaning |
|---|---|---|---|
| `id` | yes | — | Unique task id, e.g. `L1`. |
| `prompt` | yes | — | Exact instruction sent to the agent. |
| `owner` | yes* | agent name | Queue name. Tasks with the same owner run one after another. |
| `command` | no | `owner` | Agent CLI: `claude`, `codex` (aliases `chatgpt`, `openai`) or `agy` (alias `antigravity`). *Either `owner` or `command` must name a known agent. |
| `task` | no | start of prompt | Short title shown in status and dashboard. |
| `worktree` | no | `../<repo>-<owner>` | Worktree path, relative to the git repository root (also when `maw` runs from a subdirectory). Created with `git worktree add` if missing. |
| `branch` | no | `maw/<owner>` | Branch checked out in the worktree. Created from `base` if missing. |
| `base` | no | `HEAD` | Starting point for a new branch. |
| `depends_on` | no | `[]` | Task ids that must be `done` first. If one fails, this task is `skipped`. |
| `check` | no | — | Shell command run in the worktree after the agent exits 0. Non-zero exit marks the task `blocked`. |
| `model` | no | CLI default | Model passed to the agent (`CLAUDE_MODEL`, `CODEX_MODEL`, `AGY_MODEL` env vars also work). |
| `effort` | no | CLI default | Reasoning effort (`CLAUDE_EFFORT`, `CODEX_EFFORT`, `AGY_EFFORT`). |
| `timeout_minutes` | no | `60` | The agent is stopped and the task blocked after this long. |

## Scheduling rules

- Each owner's queue runs in file order. Different owners run in parallel.
- A task starts when its `depends_on` tasks are `done` and its worktree is free.
- If a task is `blocked`, the rest of that owner's queue is `skipped`, as are tasks depending on it.
- `maw` exits 0 only if every task is `done`.

## Task states and status record

States: `pending` → `running` → `done` | `blocked` | `skipped`.

Each entry in `.agent-workbench/status.json` → `tasks` records: `id`, `owner`, `agent`, `task`, `worktree`, `branch`, `depends_on`, `state`, `commit` (new `HEAD` after the task, or `null` if the agent made no commit), `commits` (all new commits), `dirty` (uncommitted changes left behind), `check` (`{ command, passed }`), `exit_code`, `reason`, `started_at`, `finished_at` and the last 30 `output` lines. Full output is in `.agent-workbench/logs/<id>.log`.

## Example

```json
[
  { "id": "L1", "owner": "claude", "task": "Orders API", "prompt": "Add GET /api/orders with pagination. Run the API tests and commit.", "check": "npm test -- orders" },
  { "id": "C1", "owner": "codex", "task": "Orders page", "prompt": "Build the orders page against the existing API types. Run lint and commit." },
  { "id": "A1", "owner": "antigravity", "command": "agy", "task": "QA", "depends_on": ["L1", "C1"], "prompt": "Merge branches maw/claude and maw/codex into this branch, run all tests, fix only clear bugs, and commit." }
]
```
