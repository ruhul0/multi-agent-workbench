import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { git } from "./git.mjs";

const MAX_DIFF = 1024 * 1024;

/**
 * Serve the live status page for .agent-workbench/status.json on localhost.
 * With a `control` object from runWorkbench, the page can also stop tasks.
 * Requests must use a localhost Host header (blocks DNS rebinding), and actions need a
 * per-server token that is only embedded in the page itself (blocks cross-site requests).
 */
export function dashboard({ root = process.cwd(), port = 4317, host = "127.0.0.1", control = null } = {}) {
  const statusPath = resolve(root, ".agent-workbench/status.json");
  const token = randomBytes(16).toString("hex");
  let boundPort = port;

  const server = createServer(async (req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(body);
    };
    const json = (code, value) => send(code, "application/json", JSON.stringify(value));
    if (!allowedHost(req.headers.host, boundPort)) return send(421, "text/plain", "Misdirected request");

    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/status.json") {
        try {
          send(200, "application/json", await readFile(statusPath, "utf8"));
        } catch {
          json(404, { error: "No status yet. Run `maw` in this project." });
        }
        return;
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const page = (await readFile(PAGE_URL, "utf8")).replace("/*MAW_CONFIG*/", `window.MAW=${JSON.stringify({ token, actions: Boolean(control) })};`);
        res.setHeader("content-security-policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'");
        return send(200, "text/html; charset=utf-8", page);
      }
      if (req.method === "GET" && url.pathname === "/api/diff") {
        const status = JSON.parse(await readFile(statusPath, "utf8"));
        return send(200, "text/plain; charset=utf-8", taskDiff(status, url.searchParams.get("task"), url.searchParams.get("sha")));
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        if (req.headers["x-maw-token"] !== token) return json(403, { error: "missing or wrong token" });
        if (!control) return json(409, { error: "this dashboard is read-only; actions work while `maw run` is serving it" });
        const body = await readBody(req);
        if (url.pathname === "/api/stop") return json(200, { ok: Boolean(control.stopTask?.(String(body.id || ""))) });
        if (url.pathname === "/api/stop-all") return json(200, { ok: Boolean(control.stopAll?.()) });
      }
      send(404, "text/plain", "Not found");
    } catch (error) {
      json(500, { error: error.message });
    }
  });

  // If the port is taken (e.g. another maw run), try the next few ports.
  return new Promise((resolveUrl, reject) => {
    let attempt = 0;
    const onError = (error) => {
      if (error.code === "EADDRINUSE" && attempt++ < 10) tryListen(boundPort + 1);
      else reject(error);
    };
    const tryListen = (p) => {
      boundPort = p;
      server.once("error", onError);
      server.listen(p, host, () => {
        server.off("error", onError);
        resolveUrl({ server, url: `http://${host}:${p}` });
      });
    };
    tryListen(port);
  });
}

function allowedHost(header, port) {
  if (!header) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(header.toLowerCase());
}

/** Diff for one commit of a task, or everything the task changed (including uncommitted work). */
export function taskDiff(status, id, sha) {
  const t = (status.tasks || []).find(x => x.id === id);
  if (!t) return "Unknown task.";
  if (sha) {
    if (!/^[0-9a-f]{4,40}$/.test(sha) || !(t.commits || []).some(c => c.sha?.startsWith(sha) || c.short === sha)) return "That commit does not belong to this task.";
    return cap(git(t.worktree, ["show", "--stat", "--patch", "--format=commit %H%nAuthor: %an%nDate:   %aI%n%n    %s%n", sha]).out);
  }
  if (!t.base_commit) return "This task has not started yet.";
  const committed = git(t.worktree, ["diff", "--stat", "--patch", t.base_commit]).out;
  const untracked = git(t.worktree, ["ls-files", "--others", "--exclude-standard"]).out;
  return cap((committed || "No changes yet.") + (untracked ? `\n\nNew files not yet added to git:\n${untracked}` : ""));
}

function cap(text) {
  return text.length > MAX_DIFF ? text.slice(0, MAX_DIFF) + "\n\n… diff truncated" : text;
}

function readBody(req) {
  return new Promise((done, fail) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 10_000) { fail(new Error("request too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { fail(new Error("invalid JSON")); } });
    req.on("error", fail);
  });
}

/** Open a URL in the default browser. Failures are ignored (headless machines, SSH sessions). */
export function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

const PAGE_URL = new URL("./dashboard.html", import.meta.url);
