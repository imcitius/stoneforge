type Rectangle = { x: number; y: number; width: number; height: number };

/** Outer window bounds, including native chrome, on the owner's display. */
export function logsBounds(area: Rectangle): Rectangle {
  const width = Math.max(1, Math.min(800, area.width - 32));
  const height = Math.max(1, Math.min(560, area.height - 32));
  return { x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2), width, height };
}

const escapeHTML = (text: string): string => text.replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

export function logsHTML(name: string, logs?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(name)} — Logs</title>
<style>
:root{color-scheme:dark;--bg:#0f172a;--surface:#1e293b;--border:#334155;--text:#f1f5f9;--muted:#94a3b8;--accent:#60a5fa;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text);background:var(--bg)}
*{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden}
body{display:flex;flex-direction:column;padding:16px;gap:12px}
header,footer{flex:none}h1{font-size:16px;line-height:1.5;margin:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
p{color:var(--muted);margin:4px 0 0;line-height:1.5}
pre{flex:1;min-height:0;min-width:0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:12px;border:1px solid var(--border);background:var(--surface);font:12px/1.5 ui-monospace,Menlo,monospace;tab-size:4}
footer{display:flex;justify-content:flex-end}button{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 24px;cursor:pointer}
button:hover{border-color:var(--muted)}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style></head><body>
<header><h1>${escapeHTML(name)} — Logs</h1><p>Latest 10,000 characters · Snapshot from this run</p></header>
<pre tabindex="0" aria-label="Project logs">${escapeHTML(logs?.slice(-10_000) || 'No logs yet')}</pre>
<footer><button id="close" type="button" autofocus>Close</button></footer>
</body></html>`;
}
