// Agent CLI definitions shared by the supervisor and `maw doctor`.
// Binaries can be overridden with MAW_BIN_CLAUDE, MAW_BIN_CODEX, MAW_BIN_AGY (useful for tests and custom installs).

const ALIASES = { claude: "claude", codex: "codex", chatgpt: "codex", openai: "codex", agy: "agy", antigravity: "agy" };

export const AGENTS = {
  claude: {
    label: "Claude Code",
    bin: () => process.env.MAW_BIN_CLAUDE || "claude",
    args: (task) => [
      "-p", task.prompt,
      "--output-format", "stream-json", "--verbose", // stream progress instead of printing only at the end
      "--dangerously-skip-permissions",
      ...opt("--model", task.model || process.env.CLAUDE_MODEL),
      ...opt("--effort", task.effort || process.env.CLAUDE_EFFORT),
    ],
    auth: ["auth", "status"],
    format: formatClaudeEvent,
  },
  codex: {
    label: "Codex CLI",
    bin: () => process.env.MAW_BIN_CODEX || "codex",
    args: (task) => [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      ...opt("-m", task.model || process.env.CODEX_MODEL),
      ...(task.effort || process.env.CODEX_EFFORT ? ["-c", `model_reasoning_effort="${task.effort || process.env.CODEX_EFFORT}"`] : []),
      "--", // so a prompt starting with "-" is not parsed as a flag
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

/**
 * Turn one line of Claude Code `stream-json` output into readable lines.
 * Non-JSON lines pass through unchanged; events with nothing to show return [].
 */
export function formatClaudeEvent(line) {
  let event;
  try { event = JSON.parse(line); } catch { return [line]; }
  if (!event || typeof event !== "object") return [line];
  if (event.type === "assistant") {
    const out = [];
    for (const part of event.message?.content || []) {
      if (part.type === "text" && part.text?.trim()) out.push(...part.text.trim().split("\n"));
      else if (part.type === "tool_use") out.push(`▸ ${part.name}${summarizeInput(part.input)}`);
    }
    return out;
  }
  if (event.type === "user") {
    const errors = (event.message?.content || []).filter(p => p.type === "tool_result" && p.is_error);
    return errors.map(p => `  ✕ ${firstLine(p.content)}`);
  }
  if (event.type === "result") {
    return [event.is_error ? `✕ ${event.subtype || "error"}: ${firstLine(event.result)}` : `✓ finished${event.num_turns ? ` in ${event.num_turns} turn${event.num_turns === 1 ? "" : "s"}` : ""}`];
  }
  return [];
}

function summarizeInput(input) {
  if (!input || typeof input !== "object") return "";
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt;
  return v ? `: ${firstLine(v).slice(0, 160)}` : "";
}

function firstLine(v) {
  const text = Array.isArray(v) ? v.map(x => x?.text ?? "").join(" ") : String(v ?? "");
  return text.trim().split("\n")[0];
}

function opt(flag, value) {
  return value ? [flag, String(value)] : [];
}

/** Resolve a task's `command` (or `owner`) to an agent key, or null if unknown. */
export function resolveAgent(task) {
  const name = String(task.command || task.owner || "").trim().toLowerCase();
  return ALIASES[name] || null;
}
