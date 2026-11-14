// Agent CLI definitions shared by the supervisor, `maw plan` and `maw doctor`.
// Built-in binaries can be overridden with MAW_BIN_CLAUDE, MAW_BIN_CODEX, MAW_BIN_AGY
// (custom agents: MAW_BIN_<NAME>), which is useful for tests and custom installs.
//
// An agent definition:
//   label            display name
//   bin()            executable to run
//   args(task, ctx)  argv for a task run; ctx = { prompt, resume } where `resume` is a
//                    session id from an earlier attempt (only when `resume: true`)
//   resume           true when args() can continue an earlier session
//   planArgs(prompt) argv for a read-only planning run whose stdout is the answer
//   auth             argv for a non-interactive login check, or null
//   login            command that logs in, shown by `maw doctor`
//   format(line)     optional: turn one stdout line into readable lines
//   parse(line)      optional: extract { session_id } or { usage: { cost_usd, turns, input_tokens, output_tokens } }

const BUILTIN_ALIASES = { claude: "claude", codex: "codex", chatgpt: "codex", openai: "codex", agy: "agy", antigravity: "agy" };

export const AGENTS = {
  claude: {
    label: "Claude Code",
    bin: () => process.env.MAW_BIN_CLAUDE || "claude",
    args: (task, { prompt = task.prompt, resume = null } = {}) => [
      "-p", prompt,
      ...opt("--resume", resume),
      "--output-format", "stream-json", "--verbose", // stream progress instead of printing only at the end
      "--dangerously-skip-permissions",
      ...opt("--model", task.model || process.env.CLAUDE_MODEL),
      ...opt("--effort", task.effort || process.env.CLAUDE_EFFORT),
      ...opt("--max-budget-usd", task.max_cost_usd),
    ],
    resume: true,
    planArgs: (prompt) => ["-p", prompt],
    auth: ["auth", "status"],
    login: "claude auth login",
    format: formatClaudeEvent,
    parse: parseClaudeEvent,
  },
  codex: {
    label: "Codex CLI",
    bin: () => process.env.MAW_BIN_CODEX || "codex",
    args: (task, { prompt = task.prompt, resume = null } = {}) => [
      "exec",
      ...(resume ? ["resume"] : []),
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      ...opt("-m", task.model || process.env.CODEX_MODEL),
      ...(task.effort || process.env.CODEX_EFFORT ? ["-c", `model_reasoning_effort=${JSON.stringify(String(task.effort || process.env.CODEX_EFFORT))}`] : []),
      "--", // so a prompt starting with "-" is not parsed as a flag
      ...(resume ? [resume] : []),
      prompt,
    ],
    resume: true,
    planArgs: (prompt) => ["exec", "--sandbox", "read-only", "--", prompt],
    auth: ["login", "status"],
    login: "codex login",
    format: formatCodexEvent,
    parse: parseCodexEvent,
  },
  agy: {
    label: "Antigravity CLI",
    bin: () => process.env.MAW_BIN_AGY || "agy",
    args: (task, { prompt = task.prompt } = {}) => [
      "--dangerously-skip-permissions",
      "--print", prompt,
      ...opt("--model", task.model || process.env.AGY_MODEL),
      ...opt("--effort", task.effort || process.env.AGY_EFFORT),
    ],
    resume: false,
    planArgs: (prompt) => ["--mode", "plan", "--print", prompt],
    auth: null, // agy has no non-interactive login check
    login: "agy",
  },
};

/**
 * Build the agent registry: built-ins plus custom agents from the `agents` section of tasks.json.
 * Custom agents describe their argv with templates; see references/task-schema.md.
 */
export function agentRegistry(custom = {}) {
  const registry = { ...AGENTS };
  const aliases = { ...BUILTIN_ALIASES };
  for (const [name, spec] of Object.entries(custom || {})) {
    registry[name] = customAgent(name, spec);
    aliases[name] = name;
    for (const a of spec.aliases || []) aliases[String(a).toLowerCase()] = name;
  }
  Object.defineProperty(registry, "aliases", { value: aliases, enumerable: false });
  return registry;
}

/** Validate one custom agent spec; returns a list of problems. */
export function validateCustomAgent(name, spec) {
  const errors = [];
  const where = `agents.${name}`;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) errors.push(`${where}: name must be lowercase letters, digits, "-" or "_"`);
  if (!spec || typeof spec !== "object") return [...errors, `${where}: must be an object`];
  if (typeof spec.bin !== "string" || !spec.bin) errors.push(`${where}: "bin" must be the executable name`);
  if (!Array.isArray(spec.args) || !JSON.stringify(spec.args).includes("{prompt}")) errors.push(`${where}: "args" must be an array that includes "{prompt}"`);
  if (spec.plan_args != null && !Array.isArray(spec.plan_args)) errors.push(`${where}: "plan_args" must be an array`);
  if (spec.auth != null && !Array.isArray(spec.auth)) errors.push(`${where}: "auth" must be an array of arguments or null`);
  if (spec.aliases != null && !Array.isArray(spec.aliases)) errors.push(`${where}: "aliases" must be an array`);
  return errors;
}

function customAgent(name, spec) {
  const envBin = `MAW_BIN_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  return {
    label: spec.label || name,
    bin: () => process.env[envBin] || spec.bin,
    args: (task, { prompt = task.prompt } = {}) => expandTemplate(spec.args, { prompt, model: task.model, effort: task.effort, id: task.id, worktree: task.worktree }),
    resume: false,
    planArgs: (prompt) => expandTemplate(spec.plan_args || spec.args, { prompt }),
    auth: spec.auth || null,
    login: spec.login || spec.bin,
    custom: true,
  };
}

/**
 * Expand an argv template. Strings get {placeholders} replaced. A nested array is an
 * optional group, dropped entirely when any placeholder in it has no value:
 *   ["--yolo", ["--model", "{model}"], "-p", "{prompt}"]
 */
export function expandTemplate(template, values) {
  const out = [];
  const fill = (s) => {
    let missing = false;
    const text = String(s).replace(/\{(\w+)\}/g, (_, k) => {
      const v = values[k];
      if (v == null || v === "") { missing = true; return ""; }
      return String(v);
    });
    return { text, missing };
  };
  for (const entry of template || []) {
    if (Array.isArray(entry)) {
      const parts = entry.map(fill);
      if (!parts.some(p => p.missing)) out.push(...parts.map(p => p.text));
    } else {
      const { text, missing } = fill(entry);
      if (!(missing && text === "")) out.push(text);
    }
  }
  return out;
}

/**
 * Turn one line of Claude Code `stream-json` output into readable lines.
 * Non-JSON lines pass through unchanged; events with nothing to show return [].
 */
export function formatClaudeEvent(line) {
  const event = json(line);
  if (!event) return [line];
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
    const cost = typeof event.total_cost_usd === "number" ? ` · $${event.total_cost_usd.toFixed(2)}` : "";
    return [event.is_error ? `✕ ${event.subtype || "error"}: ${firstLine(event.result)}` : `✓ finished${event.num_turns ? ` in ${event.num_turns} turn${event.num_turns === 1 ? "" : "s"}` : ""}${cost}`];
  }
  return [];
}

export function parseClaudeEvent(line) {
  const event = json(line);
  if (!event) return null;
  if (event.type === "result") {
    return {
      session_id: event.session_id,
      usage: {
        cost_usd: num(event.total_cost_usd),
        turns: num(event.num_turns),
        input_tokens: num(event.usage?.input_tokens) + num(event.usage?.cache_read_input_tokens) + num(event.usage?.cache_creation_input_tokens),
        output_tokens: num(event.usage?.output_tokens),
      },
    };
  }
  if (event.session_id) return { session_id: event.session_id };
  return null;
}

/** Turn one line of `codex exec --json` output into readable lines. */
export function formatCodexEvent(line) {
  const event = json(line);
  if (!event) return [line];
  const item = event.item || {};
  if (event.type === "item.started" && item.type === "command_execution") return [`▸ ${firstLine(item.command).slice(0, 160)}`];
  if (event.type === "item.completed") {
    switch (item.type) {
      case "agent_message": return String(item.text || "").trim().split("\n").filter(Boolean);
      case "command_execution": return item.exit_code ? [`  ✕ exit ${item.exit_code}: ${firstLine(item.command).slice(0, 120)}`] : [];
      case "file_change": return (item.changes || []).map(c => `▸ ${c.kind || "edit"} ${c.path}`);
      case "mcp_tool_call": return [`▸ ${[item.server, item.tool].filter(Boolean).join(".")}`];
      case "web_search": return [`▸ search: ${firstLine(item.query)}`];
      case "error": return [`! ${firstLine(item.message)}`];
      default: return [];
    }
  }
  if (event.type === "turn.completed") return ["✓ turn finished"];
  if (event.type === "turn.failed") return [`✕ ${firstLine(event.error?.message || "turn failed")}`];
  if (event.type === "error") return [`✕ ${firstLine(event.message)}`];
  return [];
}

export function parseCodexEvent(line) {
  const event = json(line);
  if (!event) return null;
  if (event.type === "thread.started" && event.thread_id) return { session_id: event.thread_id };
  if (event.type === "turn.completed") {
    return { usage: { cost_usd: 0, turns: 1, input_tokens: num(event.usage?.input_tokens), output_tokens: num(event.usage?.output_tokens) } };
  }
  return null;
}

function json(line) {
  if (!line || line[0] !== "{") return null;
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
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
  return value != null && value !== "" ? [flag, String(value)] : [];
}

/** Resolve a task's `command` (or `owner`) to an agent key, or null if unknown. */
export function resolveAgent(task, registry = null) {
  const aliases = registry?.aliases || BUILTIN_ALIASES;
  const name = String(task.command || task.owner || "").trim().toLowerCase();
  return aliases[name] || null;
}
