// Drives the bundled server the way Claude Code does (stdio MCP) through
// every tool, on a local test site. Prints each answer, shortened.
// Usage: node test/smoke.mjs <chrome.exe> [--headed]
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = process.argv[2];
const headed = process.argv.includes('--headed');
if (!exe) throw new Error('usage: node test/smoke.mjs <chrome.exe> [--headed]');

const PAGES = {
  '/': `<!doctype html><title>Smoke home</title>
<h1>Smoke test</h1>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Hello ' + document.getElementById('name').value;">
  <label>Name <input id="name" required></label>
  <label>Email <input id="email" type="email"></label>
  <button>Say hello</button>
</form>
<p id="out" role="status" aria-live="polite"></p>
<button onclick="this.textContent = confirm('Sure?') ? 'Confirmed' : 'Cancelled'">Ask</button>
<a href="/two">Page two</a>
<div style="height: 2000px"></div>
<button onclick="this.textContent='Bottom clicked'">Bottom button</button>`,
  '/two': `<!doctype html><title>Smoke two</title><h1>Page two</h1><a href="/">Home</a>`,
};
const site = http.createServer((req, res) => {
  res.writeHead(PAGES[req.url] ? 200 : 404, { 'content-type': 'text/html' });
  res.end(PAGES[req.url] ?? 'not found');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${site.address().port}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve(here, '../../plugin/dist/server.mjs')],
  env: { ...process.env, CHROMAPHORE_BROWSER: exe },
  stderr: 'inherit',
});
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);
console.log(`instructions: ${client.getInstructions()?.length ?? 0} characters\n`);

const ids = {};
async function call(name, args = {}, { show = 1200 } = {}) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const ms = Date.now() - t0;
  const parts = r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type} ${c.mimeType} ${c.data.length} base64 chars]`));
  const text = parts.join('\n');
  console.log(`== ${name} ${JSON.stringify(args)} ${r.isError ? 'ERROR ' : ''}(${ms} ms)`);
  console.log(text.length > show ? `${text.slice(0, show)}\n…(${text.length - show} more)` : text);
  console.log();
  // Remember ids by name for the next calls.
  for (const m of text.matchAll(/^[+ ]*([a-z]+\d+) (\w+) "([^"]*)"/gm)) ids[`${m[2]}:${m[3]}`] = m[1];
  const snap = /snapshot_id (s\d+)/.exec(text);
  if (snap) ids.snapshot = snap[1];
  return { text, isError: r.isError };
}

try {
  await call('browser_open', { url: `${origin}/`, headless: !headed });
  // A first scroll puts the pointer somewhere: v153 browsers need that before
  // revealElement (they predate its pointerX/pointerY names).
  if (process.argv.includes('--v153')) {
    await call('scroll', { direction: 'down', amount: 100 });
    await call('scroll', { direction: 'up', amount: 100 });
  }
  await call('observe');
  await call('type', { id: ids['textbox:Name'], text: 'Ada Lovelace' });
  await call('type', { id: ids['textbox:Email'], text: 'ada@example.com', exact: true });
  await call('click', { id: ids['button:Say hello'] });
  await call('click', { id: ids['button:Ask'] });
  await call('observe');
  await call('dialog', { accept: true });
  await call('scroll', { direction: 'down', amount: 1500 });
  await call('click', { id: ids['button:Bottom button'] });
  await call('press', { keys: 'Ctrl+Home' });
  await call('hover', { id: ids['link:Page two'] });
  await call('click', { id: ids['link:Page two'] });
  await call('navigate', { action: 'back' });
  await call('eval_js', { expression: 'document.title + " / " + document.querySelectorAll("button").length' });
  await call('view', { snapshot_id: ids.snapshot });
  await call('screenshot', { path: path.resolve(here, '../../.scratch/smoke.png') });
  await call('tab_new', { url: `${origin}/two` });
  await call('tab_list');
  await call('tab_select', { tab: 't1' });
  await call('click', { id: 'a999' });
} finally {
  await call('browser_close');
  await client.close();
  site.close();
}
