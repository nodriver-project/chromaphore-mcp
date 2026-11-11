// Drives the phase 2 tools through the bundled server on a page of native
// controls: select, date and time, colour, files, a slider, a sortable list,
// paste, fetch, a recording and the fingerprint report.
// Usage: node test/phase2.mjs <chrome.exe> [--headed]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, '../../.scratch');
const exe = process.argv[2];
if (!exe) throw new Error('usage: node test/phase2.mjs <chrome.exe> [--headed]');

const PAGE = `<!doctype html><title>Controls</title>
<h1>Controls</h1>
<label>Fruit <select id="fruit"><option value="a">Apple</option><option value="b">Banana</option><option value="c">Cherry</option></select></label>
<label>Colours <select id="many" multiple size="3"><option>Red</option><option>Green</option><option>Blue</option></select></label>
<label>Day <input type="date" id="day"></label>
<label>Time <input type="time" id="tm"></label>
<label>Colour <input type="color" id="col" value="#000000"></label>
<label>Attachment <input type="file" id="f"></label>
<label>Volume <input type="range" id="vol" min="0" max="100" value="10"></label>
<ul id="list" aria-label="Order">
  <li draggable="true">One</li><li draggable="true">Two</li><li draggable="true">Three</li>
</ul>
<label>Notes <textarea id="notes"></textarea></label>
<p id="out" role="status"></p>
<script>
let dragged = null;
const list = document.getElementById('list');
list.addEventListener('dragstart', (e) => { dragged = e.target; e.dataTransfer.setData('text/plain', ''); });
list.addEventListener('dragover', (e) => e.preventDefault());
list.addEventListener('drop', (e) => { e.preventDefault(); const t = e.target.closest('li'); if (t && dragged && t !== dragged) list.insertBefore(dragged, t); });
document.getElementById('f').addEventListener('change', (e) => { document.getElementById('out').textContent = 'File: ' + e.target.files[0]?.name; });
</script>`;
const site = http.createServer((req, res) => {
  if (req.url === '/api') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, method: req.method }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${site.address().port}`;
fs.mkdirSync(scratch, { recursive: true });
const upload = path.join(scratch, 'upload-test.txt');
fs.writeFileSync(upload, 'hello from the phase 2 test\n');

const client = new Client({ name: 'phase2', version: '0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(here, '../../plugin/dist/server.mjs')],
    env: { ...process.env, CHROMAPHORE_BROWSER: exe, CLAUDE_CODE_SESSION_ID: '' },
    stderr: 'inherit',
  }),
);
const ids = {};
async function call(name, args = {}, show = 900) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const text = r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  console.log(`== ${name} ${JSON.stringify(args)} ${r.isError ? 'ERROR ' : ''}(${Date.now() - t0} ms)`);
  console.log(text.length > show ? `${text.slice(0, show)}\n…(${text.length - show} more)` : text, '\n');
  for (const m of text.matchAll(/^[+ ]*([a-z]+\d+) ([\w-]+(?: input)?) "([^"]*)"/gm)) {
    if (m[2] !== 'label') ids[m[3]] ??= m[1];
  }
  return text;
}

try {
  await call('browser_open', { headless: !process.argv.includes('--headed') });
  await call('record_start', { path: path.join(scratch, 'rec-phase2') });
  await call('navigate', { url: `${origin}/` }, 2500);
  await call('select', { id: ids.Fruit, values: ['Cherry'] });
  await call('select', { id: ids.Fruit, values: ['Durian'] });
  await call('select', { id: ids.Colours, values: ['Red', 'Blue'] });
  await call('fill_date', { id: ids.Day, value: '2026-11-05' });
  await call('fill_date', { id: ids.Time, value: '14:30' });
  await call('pick_color', { id: ids.Colour, value: '#3366cc' });
  await call('upload', { id: ids['Attachment: No file chosen'], files: [upload] });
  await call('drag', { from: ids.Volume, value: 75 });
  await call('drag', { from: ids.Three, to: ids.One });
  await call('paste', { id: ids.Notes, text: 'Pasted line one\nPasted line two' });
  await call('eval_js', {
    expression:
      '({fruit: fruit.value, many: [...many.selectedOptions].map(o => o.text), day: day.value, tm: tm.value, col: col.value, file: f.files[0]?.name, vol: vol.value, order: [...list.children].map(l => l.textContent), notes: notes.value})',
  });
  await call('fetch', { url: `${origin}/api` });
  await call('fetch', { url: `${origin}/api`, method: 'POST', body: '{"x":1}', headers: { 'content-type': 'application/json' } });
  await call('fetch', { url: `${origin}/` }, 600);
  await call('fingerprint');
  await call('record_stop', {}, 1500);
} finally {
  await call('browser_close');
  await client.close();
  site.close();
}
