// Points read off a scaled screenshot: with fingerprint seed 1 the headless
// view is 1920x945, over the browser's screenshot budget (about 1,125,000
// pixels), so the image is smaller than the view. view says so; a point in
// the image's pixels with its snapshot_id lands where the image shows it; a
// snapshot of another page or another tab is refused, and so is snapshot_id
// with an id. The note's image size is checked against the JPEG's own
// header; hover and drag take image points with snapshot_id too.
// Usage: node test/view_scale.mjs [server.mjs]
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = process.argv[2] ?? path.resolve(here, '../../plugin/dist/server.mjs');

const page = `<!doctype html><meta charset="utf-8"><title>scale</title>
<div id="target" style="position:absolute;left:1500px;top:700px;width:60px;height:40px;background:#cfc">target</div>
<div id="pad" style="position:absolute;left:200px;top:500px;width:600px;height:100px;background:#eef">pad</div>
<script>window.__clicks = []; document.addEventListener('click', (e) => window.__clicks.push([e.clientX, e.clientY, e.target.id]), true);
window.__over = []; document.addEventListener('mouseover', (e) => window.__over.push(e.target.id), true);
window.__drag = []; for (const t of ['mousedown', 'mouseup']) document.addEventListener(t, (e) => window.__drag.push([t, e.clientX, e.clientY, e.target.id]), true);</script>`;
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const env = { ...process.env };
delete env.CLAUDE_CODE_SESSION_ID;
delete env.CHROMAPHORE_BROWSER;
// The browser under test: CHROMAPHORE_TEST_BROWSER, else the installed release.
if (process.env.CHROMAPHORE_TEST_BROWSER) env.CHROMAPHORE_BROWSER = process.env.CHROMAPHORE_TEST_BROWSER;
const client = new Client({ name: 'scale-test', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'inherit' }));

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`  ${name} ${JSON.stringify(args).slice(0, 140)}: ${r.isError ? 'ERROR ' : ''}${text.split('\n')[0]}`);
  return { text, isError: !!r.isError, images: r.content.filter((c) => c.type === 'image') };
}
// A JPEG's width and height, from its frame header (SOF0 to SOF15, less
// DHT, JPG and DAC, which share the range).
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}
const js = async (expression) => JSON.parse((await call('eval_js', { expression: `JSON.stringify(${expression})` })).text);

let r = await call('browser_open', { profile: 'temp', headless: true, seed: 1, url: base });
const view = /View (\d+)x(\d+)/.exec(r.text);
check(!!view && view[1] * view[2] > 1_125_000, `seed 1 gives a view over the screenshot budget (${view?.[0]})`);
const snap = /snapshot_id (s\d+)/.exec(r.text)?.[1];
r = await call('view', { snapshot_id: snap });
console.log(`  note: ${r.text}`);
const m = /The image is (\d+)x(\d+) pixels of a (\d+)x(\d+) view \(scale ([\d.]+)\)/.exec(r.text);
const scale = m ? Number(m[5]) : 1;
const real = r.images[0] ? jpegSize(Buffer.from(r.images[0].data, 'base64')) : null;
check(
  !!m && !!real && scale < 1 && Math.abs(m[1] - real.width) <= 1 && Math.abs(m[2] - real.height) <= 1 && Math.abs(real.width / m[3] - scale) < 0.002,
  `view tells the image's real size and its scale (note ${m?.[1]}x${m?.[2]}, the JPEG ${real?.width}x${real?.height}, scale ${scale})`,
);

// The target's middle as the image shows it.
const mid = { x: 1530, y: 720 };
const inImage = { x: Math.round(mid.x * scale), y: Math.round(mid.y * scale) };
r = await call('click', { x: inImage.x, y: inImage.y, snapshot_id: snap, quiet: true });
const clicks = await js('window.__clicks');
const last = clicks.at(-1);
check(!r.isError && last?.[2] === 'target' && Math.abs(last[0] - mid.x) <= 4 && Math.abs(last[1] - mid.y) <= 4, `a point in image pixels with snapshot_id landed at ${JSON.stringify(last)} (meant ${mid.x},${mid.y})`);
// The same numbers as CSS pixels miss the target.
r = await call('click', { x: inImage.x, y: inImage.y, quiet: true });
check((await js('window.__clicks')).at(-1)?.[2] !== 'target', 'the same numbers without snapshot_id are CSS pixels and miss it');

// hover and drag read image points the same way.
await call('eval_js', { expression: 'window.__over.length = 0' });
r = await call('hover', { x: inImage.x, y: inImage.y, snapshot_id: snap });
const over = await js('window.__over');
check(/^The pointer is at \(/.test(r.text) && over.includes('target'), `hover at an image point with snapshot_id reached the target (${JSON.stringify(over)})`);
await call('eval_js', { expression: 'window.__drag.length = 0' });
const dFrom = { x: 250, y: 550 };
const dTo = { x: 700, y: 550 };
r = await call('drag', { from_x: Math.round(dFrom.x * scale), from_y: Math.round(dFrom.y * scale), x: Math.round(dTo.x * scale), y: Math.round(dTo.y * scale), snapshot_id: snap, quiet: true });
const dr = await js('window.__drag');
const down = dr.find((e) => e[0] === 'mousedown');
const up = dr.find((e) => e[0] === 'mouseup');
check(
  /^Dragged from/.test(r.text) && !!down && !!up && Math.abs(down[1] - dFrom.x) <= 4 && Math.abs(down[2] - dFrom.y) <= 4 && Math.abs(up[1] - dTo.x) <= 4 && Math.abs(up[2] - dTo.y) <= 4,
  `drag with snapshot_id pressed and let go where the image shows (${JSON.stringify(dr)})`,
);

r = await call('click', { id: 'a1', snapshot_id: snap });
check(r.isError && /not for an id/.test(r.text), 'snapshot_id with an id is refused');

// Another tab's snapshot, then a page the tab has left.
r = await call('tab_new', { url: base });
const other = /snapshot_id (s\d+)/.exec(r.text)?.[1];
await call('tab_select', { tab: 't1' });
r = await call('click', { x: 10, y: 10, snapshot_id: other });
check(r.isError && /another tab/.test(r.text), 'a snapshot of another tab is refused');
await call('navigate', { action: 'reload' });
r = await call('click', { x: 10, y: 10, snapshot_id: snap });
check(r.isError && /has since left/.test(r.text), 'a snapshot of a page the tab has left is refused');

await call('browser_close');
await client.close();
site.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
