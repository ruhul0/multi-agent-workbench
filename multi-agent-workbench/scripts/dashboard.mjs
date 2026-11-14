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
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
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

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Workbench</title><style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e3de;--done:#1f7a3f;--run:#1d5fd1;--bad:#b42318;--skip:#8a6d00}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ececea;--muted:#9a9a94;--card:#1e1e1c;--line:#33332f;--done:#4cc27a;--run:#6aa0ff;--bad:#ff7b6e;--skip:#e0b93a}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 4px}.muted{color:var(--muted)}.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0}.row{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.badge{font-size:12px;font-weight:600;text-transform:uppercase}.done{color:var(--done)}.running,.working{color:var(--run)}.blocked{color:var(--bad)}.skipped,.pending{color:var(--skip)}
pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;max-height:220px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-word;margin:8px 0 0}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}code{font-size:12px}
.wrap{overflow-x:auto}</style></head><body><main>
<h1>Agent Workbench</h1><div class="muted" id="meta">Loading…</div>
<div class="grid" id="agents"></div><h2>Tasks</h2><div class="card wrap"><table><thead><tr><th>Task</th><th>Owner</th><th>State</th><th>Commit</th><th>Notes</th></tr></thead><tbody id="tasks"></tbody></table></div>
<h2>Recent events</h2><pre id="recent"></pre></main><script>
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function tick(){try{const r=await fetch("/status.json",{cache:"no-store"});const s=await r.json();
if(s.error){document.getElementById("meta").textContent=s.error;return}
const age=Math.round((Date.now()-new Date(s.updated_at))/1000);
document.getElementById("meta").textContent=(s.finished?"Finished":"Running")+" · updated "+age+"s ago · "+s.root;
document.getElementById("agents").innerHTML=Object.entries(s.agents||{}).map(([o,a])=>'<div class="card"><div class="row"><strong>'+esc(o)+'</strong><span class="badge '+esc(a.state)+'">'+esc(a.state)+'</span></div><div>'+esc(a.task_id)+' — '+esc(a.task)+'</div><div class="muted">commit '+esc(a.commit||"—")+'</div><pre>'+esc((a.output||[]).join("\\n"))+'</pre></div>').join("")||'<div class="muted">No agent has started yet.</div>';
document.getElementById("tasks").innerHTML=(s.tasks||[]).map(t=>'<tr><td><code>'+esc(t.id)+'</code> '+esc(t.task)+'</td><td>'+esc(t.owner)+'</td><td class="badge '+esc(t.state)+'">'+esc(t.state)+'</td><td><code>'+esc(t.commit||"—")+'</code></td><td class="muted">'+esc([t.reason,t.check&&("check "+(t.check.passed==null?"pending":t.check.passed?"passed":"failed")),t.dirty&&"uncommitted changes"].filter(Boolean).join(" · "))+'</td></tr>').join("");
document.getElementById("recent").textContent=(s.recent||[]).slice().reverse().join("\\n");}catch(e){document.getElementById("meta").textContent="Waiting for status… "+e.message}}
tick();setInterval(tick,2000);</script></body></html>`;
