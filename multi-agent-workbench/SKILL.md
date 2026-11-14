---
name: multi-agent-workbench
description: Orchestrate multiple local coding-agent CLIs in isolated worktrees with micro-task queues, handoffs, live status, review gates, and optional deployment triggers.
---

# Multi-agent workbench

Use this skill when a software task benefits from multiple coding-agent CLIs working in parallel.

- Split work into bounded micro-tasks with owners, dependencies, and acceptance checks.
- Give each agent its own Git worktree and branch.
- Assign frontend/integration tasks to Codex and backend/data tasks to Claude when requested.
- Capture commit, tests, changed files, output, and risks after every task.
- Review and cherry-pick centrally; never auto-merge unreviewed work.
- Keep production tests/builds on the VPS when the repository uses a server-side deployment workflow.
- Expose current state, task, commit, output, and completed history in a live status file/dashboard.

See `references/task-schema.md` for handoff records and `scripts/supervisor.mjs` for the Node.js supervisor.
