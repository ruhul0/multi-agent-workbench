import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

/** Serve a live, read-only status page for .agent-workbench/status.json on localhost. */
export function dashboard({ root = process.cwd(), port = 4317, host = "127.0.0.1" } = {}) {
  const statusPath = resolve(root, ".agent-workbench/status.json");
  const server = createServer(async (req, res) => {
    if (req.url === "/status.json") {
      try {
        const body = await readFile(statusPath, "utf8");
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(body);
      } catch {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "No status yet. Run `maw` in this project." }));
      }
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(await readFile(PAGE_URL, "utf8"));
      return;
    }
    res.writeHead(404).end();
  });
  // If the port is taken (e.g. another maw run), try the next few ports.
  return new Promise((resolveUrl, reject) => {
    let attempt = 0;
    const tryListen = (p) => {
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE" && attempt++ < 10) tryListen(p + 1);
        else reject(error);
      });
      server.listen(p, host, () => resolveUrl({ server, url: `http://${host}:${p}` }));
    };
    tryListen(port);
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
