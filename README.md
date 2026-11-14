# Multi-Agent Workbench

Run multiple coding-agent CLIs in parallel with isolated worktrees, micro-task queues, handoff history, and live status.

## Quick start

Create `tasks.json` in your project:

```json
[
  {"id":"L1","owner":"claude","worktree":"../project-claude","task":"API task","prompt":"Implement the API task and commit it."},
  {"id":"C1","owner":"codex","worktree":"../project-codex","task":"Frontend task","prompt":"Implement the frontend task and commit it."}
]
```

Run:

```bash
node /path/to/multi-agent-workbench/multi-agent-workbench/scripts/supervisor.mjs
```

The supervisor writes `.agent-workbench/status.json` and `.agent-workbench/supervisor.log`. Review each commit before merging or deploying.
