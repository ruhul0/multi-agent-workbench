// Agent CLI definitions shared by the supervisor and `maw doctor`.
// Binaries can be overridden with MAW_BIN_CLAUDE, MAW_BIN_CODEX, MAW_BIN_AGY (useful for tests and custom installs).

const ALIASES = { claude: "claude", codex: "codex", chatgpt: "codex", openai: "codex", agy: "agy", antigravity: "agy" };

export const AGENTS = {
  claude: {
    label: "Claude Code",
    bin: () => process.env.MAW_BIN_CLAUDE || "claude",
    args: (task) => [
      "-p", task.prompt,
      "--dangerously-skip-permissions",
      ...opt("--model", task.model || process.env.CLAUDE_MODEL),
      ...opt("--effort", task.effort || process.env.CLAUDE_EFFORT),
    ],
    auth: ["auth", "status"],
  },
  codex: {
    label: "Codex CLI",
    bin: () => process.env.MAW_BIN_CODEX || "codex",
    args: (task) => [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      ...opt("-m", task.model || process.env.CODEX_MODEL),
      ...(task.effort || process.env.CODEX_EFFORT ? ["-c", `model_reasoning_effort="${task.effort || process.env.CODEX_EFFORT}"`] : []),
      task.prompt,
    ],
    auth: ["login", "status"],
  },
  agy: {
    label: "Antigravity CLI",
    bin: () => process.env.MAW_BIN_AGY || "agy",
    args: (task) => [
      "--dangerously-skip-permissions",
      "--print", task.prompt,
      ...opt("--model", task.model || process.env.AGY_MODEL),
      ...opt("--effort", task.effort || process.env.AGY_EFFORT),
    ],
    auth: null, // agy has no non-interactive login check
  },
};

function opt(flag, value) {
  return value ? [flag, String(value)] : [];
}

/** Resolve a task's `command` (or `owner`) to an agent key, or null if unknown. */
export function resolveAgent(task) {
  const name = String(task.command || task.owner || "").trim().toLowerCase();
  return ALIASES[name] || null;
}
