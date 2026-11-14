# Multi-Agent Workbench

Run multiple coding-agent CLIs in parallel with isolated worktrees, micro-task queues, handoff history, and live status.

## Quick start

Create `tasks.json` in your project:

```json
[
  {"id":"L1","owner":"claude","command":"claude","worktree":"../project-claude","task":"API task","prompt":"Implement the API task and commit it."},
  {"id":"C1","owner":"codex","command":"codex","worktree":"../project-codex","task":"Frontend task","prompt":"Implement the frontend task and commit it."},
  {"id":"A1","owner":"antigravity","command":"agy","worktree":"../project-agy","task":"QA task","prompt":"Audit the current changes, fix only clear issues, and commit them."}
]
```

Install and run:

```bash
npm install -g multi-agent-workbench
multi-agent-workbench init
# edit tasks.json for your project
multi-agent-workbench doctor
multi-agent-workbench
# or without installing
npx multi-agent-workbench init
npx multi-agent-workbench
```

The supervisor reads `tasks.json` from the current project and writes `.agent-workbench/status.json` and `.agent-workbench/supervisor.log`. Review each commit before merging or deploying.

## Use as a Codex skill

Clone the repository into your Codex skills directory:

```bash
git clone https://github.com/ruhul0/multi-agent-workbench.git \
  ~/.codex/skills/multi-agent-workbench
```

Then invoke it in a Codex task with:

```text
Use $multi-agent-workbench to split this project into micro-tasks, assign frontend work to Codex, backend work to Claude, QA to Antigravity, and report live progress.
```

The skill instructions are in `multi-agent-workbench/SKILL.md`. The Node.js CLI and the skill are independent: use the skill for planning/orchestration guidance, and use `maw` to launch workers.

## Agent login check

Before assigning work, run:

```bash
maw doctor
```

It checks whether `claude`, `codex`, and `agy` are available without printing credentials.
