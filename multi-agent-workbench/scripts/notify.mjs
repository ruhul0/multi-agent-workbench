// End-of-run notifications: a desktop notification and/or a JSON webhook (Slack-compatible "text").
import { spawn } from "node:child_process";

export async function notify({ desktop = false, webhook = null, title, message, state = null }) {
  if (desktop) desktopNotification(title, message);
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `${title}: ${message}`,
          title,
          message,
          plan: state?.plan?.title || null,
          tasks: (state?.tasks || []).map(t => ({ id: t.id, owner: t.owner, state: t.state, commit: t.commit, reason: t.reason })),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      console.error(`maw: webhook notification failed (${error.message})`);
    }
  }
}

function desktopNotification(title, message) {
  const [cmd, args] = process.platform === "darwin"
    ? ["osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]]
    : process.platform === "linux" ? ["notify-send", [title, message]]
    : [null, null];
  if (!cmd) return;
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}
