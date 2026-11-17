// The focus check, cancellation, fetch's save_to and a drag whose release
// fails, on local pages: expect_focus follows open shadow roots and an
// editor whose editable is a frame's <body>, refuses an element in a frame of
// another site, and names what has the focus when it refuses (a closed
// shadow root's host); a cancelled burst stops sending and presses no submit
// Enter; save_to writes a binary and a text body and never replaces a file;
// a drag from a point whose drop target leaves the page on the press is ended
// by the browser, the button let go where it went down, and the answer says so.
// Run with the replay options setting off (test/replay_options.mjs cancels a
// wait for not_before). Also: no refusal lets a key reach the page; an
// element in a frame the check cannot
// read (a data: frame, a sandboxed one) is refused with that reason; save_to
// in a folder that cannot be made is refused before the request; an HTML page
// saved says it is the page as Markdown; a drag from a point that the page
// takes as a native drag is answered as one, as the page saw it.
// Usage: node test/focus_cancel_fetch.mjs [server.mjs]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = process.argv[2] ?? path.resolve(here, '../../plugin/dist/server.mjs');

// The second site serves the frame of another process: 127.0.0.1 and
// localhost are different sites.
let farKeys = 0;
const other = http.createServer((req, res) => {
  if (req.url.startsWith('/key')) {
    farKeys++;
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><input aria-label="Far field"><script>addEventListener("keydown", (e) => fetch("/key?k=" + encodeURIComponent(e.key)), true)</script>');
});
await new Promise((r) => other.listen(0, '127.0.0.1', r));
const farUrl = `http://localhost:${other.address().port}/`;

// A frame that tells its parent of each key (it cannot be read across origins).
const reporter = (label) =>
  `<input aria-label='${label}'><script>addEventListener('keydown', (e) => parent.postMessage('key:' + e.key, '*'), true)<\/script>`;
let saveHits = 0;
const page = `<!doctype html><meta charset="utf-8"><title>focus</title>
<style>body{font:18px/26px Arial;margin:20px} iframe{width:300px;height:50px}</style>
<p id="words">Some words to press on before a drag.</p>
<input id="main" aria-label="Main field">
<iframe id="sink" title="Key sink" srcdoc="<div contenteditable=true role=textbox aria-label='Frame field' style='min-height:30px'></div>"></iframe>
<div id="openHost"></div>
<div id="closedHost" aria-label="Closed box"></div>
<iframe id="bodyEd" title="Body editor" srcdoc="<body contenteditable=true aria-label='Body text' style='min-height:30px'></body>"></iframe>
<iframe id="design" title="Design editor" srcdoc="<body aria-label='Design text' style='min-height:30px'></body>"></iframe>
<iframe id="far" title="Far frame" src="${farUrl}"></iframe>
<textarea id="ta" aria-label="Notes" rows="2"></textarea>
<span id="gone" role="button" aria-label="Vanishing" style="display:inline-block;width:100px;height:26px;background:#fdd">Vanishing</span>
<iframe id="dataFrame" title="Data frame" src="data:text/html,${encodeURIComponent(reporter('Data field'))}"></iframe>
<iframe id="sandFrame" title="Sandboxed frame" sandbox="allow-scripts" srcdoc="${reporter('Sandboxed field').replace(/"/g, '&quot;')}"></iframe>
<div><span id="dragme" draggable="true" style="display:inline-block;width:120px;height:30px;background:#dfd">Drag me</span>
<span id="dropzone" style="display:inline-block;width:120px;height:30px;margin-left:60px;background:#ddf">Drop zone</span></div>
<script>
const open = document.getElementById('openHost').attachShadow({ mode: 'open' });
open.innerHTML = '<input aria-label="Shadow field">';
const closed = document.getElementById('closedHost').attachShadow({ mode: 'closed' });
closed.innerHTML = '<input aria-label="Hidden field">';
document.getElementById('design').addEventListener('load', (e) => { e.target.contentDocument.designMode = 'on'; });
window.__keys = [];
document.addEventListener('keydown', (e) => window.__keys.push(e.key), true);
window.__mouse = { down: 0, up: 0 };
document.addEventListener('mousedown', () => { window.__mouse.down++; if (window.__armGone) document.getElementById('gone')?.remove(); }, true);
document.addEventListener('mouseup', () => window.__mouse.up++, true);
window.__frameKeys = [];
addEventListener('message', (e) => { if (String(e.data).startsWith('key:')) window.__frameKeys.push(e.data); });
window.__pasted = 0;
document.addEventListener('paste', () => window.__pasted++, true);
window.__dnd = [];
for (const t of ['dragstart', 'dragend', 'drop', 'mouseup']) document.addEventListener(t, (e) => window.__dnd.push(t + ':' + (e.target.id || e.target.tagName)), true);
document.addEventListener('dragover', (e) => e.preventDefault(), true);
</script>`;
const site = http.createServer((req, res) => {
  if (req.url === '/bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]));
    return;
  }
  if (req.url === '/count') {
    saveHits++;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('counted');
    return;
  }
  if (req.url === '/article') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Article</title><main><h1>Saved heading</h1><p>A paragraph of the article to save.</p></main>');
    return;
  }
  if (req.url === '/txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('hello text body');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const env = { ...process.env };
delete env.CLAUDE_CODE_SESSION_ID;
delete env.CHROMAPHORE_BROWSER;
delete env.CHROMAPHORE_REPLAY_OPTIONS;
console.log('replay_options: off (CHROMAPHORE_REPLAY_OPTIONS unset)');
const client = new Client({ name: 'focus-test', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'inherit' }));

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
async function call(name, args = {}, signal) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000, ...(signal ? { signal } : {}) });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`  ${name} ${JSON.stringify(args).slice(0, 140)}: ${r.isError ? 'ERROR ' : ''}${text.split('\n')[0]}`);
  return { text, isError: !!r.isError };
}
const js = async (expression) => JSON.parse((await call('eval_js', { expression: `JSON.stringify(${expression})` })).text);

await call('browser_open', { profile: 'temp', headless: true, url: base });
// The frames load after the listing; list again once they have.
await new Promise((r) => setTimeout(r, 1500));
let r = await call('observe', { offscreen: 'full' });
const listing = r.text;
const idOf = (re) => new RegExp(`^([a-z]+\\d+) ${re}`, 'm').exec(listing)?.[1];
const ids = {
  main: idOf('textbox "Main field"'),
  frameField: idOf('textbox "Frame field"'),
  shadow: idOf('textbox "Shadow field"'),
  hidden: idOf('textbox "Hidden field"'),
  far: idOf('textbox "Far field"'),
  notes: idOf('textbox "Notes"'),
  bodyEd: idOf('Iframe "Body editor"'),
  design: idOf('Iframe "Design editor"'),
  bodyText: idOf('textbox "Body text"'),
  designText: idOf('textbox "Design text"'),
  gone: idOf('button "Vanishing"'),
};
const dataField = idOf('textbox "Data field"');
const sandField = idOf('textbox "Sandboxed field"');
console.log(`  frames the check cannot read: data field ${dataField ?? 'not listed with an id'}, sandboxed field ${sandField ?? 'not listed with an id'}`);
const noKeys = async () => {
  await call('eval_js', { expression: "window.__keys.length = 0; window.__frameKeys.length = 0; document.getElementById('main').value = ''" });
  farKeys = 0;
};
const keysSeen = async () => {
  // A key a frame posts arrives a moment later.
  await new Promise((res) => setTimeout(res, 500));
  const v = await js(`[window.__keys.length, window.__frameKeys.length, document.getElementById('main').value]`);
  return { main: v[0], frames: v[1], value: v[2], far: farKeys, none: v[0] === 0 && v[1] === 0 && v[2] === '' && farKeys === 0 };
};
console.log(`  ids ${JSON.stringify(ids)}`);
check(Object.values(ids).every(Boolean), 'every element of the test is listed');

// The frame's field had the focus, then a field of the main document took it:
// keys meant for the frame's field are refused, naming the main field.
await call('click', { id: ids.frameField, quiet: true });
await call('click', { id: ids.main, quiet: true });
await noKeys();
r = await call('type', { text: 'no', exact: true, expect_focus: ids.frameField });
let seen = await keysSeen();
check(/^Nothing sent: .* does not have the keyboard focus; input "Main field" #main has it/.test(r.text) && seen.none, `expect_focus on the frame field refused once the main field took the focus, and named it; no key reached the page (${JSON.stringify(seen)})`);

// An input inside an open shadow root passes when it has the focus.
await call('click', { id: ids.shadow, quiet: true });
r = await call('type', { text: 'in', exact: true, expect_focus: ids.shadow, quiet: true });
const shadowValue = await js(`document.getElementById('openHost').shadowRoot.querySelector('input').value`);
check(!/Nothing sent/.test(r.text) && shadowValue === 'in', `an input in an open shadow root passed the check (${JSON.stringify(shadowValue)})`);

// Inside a closed shadow root the innermost element script reaches is the
// host: the refusal names it, which shows why.
await call('click', { id: ids.hidden, quiet: true });
await noKeys();
r = await call('type', { text: 'x', exact: true, expect_focus: ids.hidden });
seen = await keysSeen();
check(/does not have the keyboard focus; div "Closed box" #closedHost has it/.test(r.text) && seen.none, `in a closed shadow root the refusal names the host; no key reached the page (${JSON.stringify(seen)})`);

// An editor whose editable is a frame's <body> (contenteditable body, and
// designMode): the body, listed as a textbox of its own, has the focus, and
// the frame element counts as having it too.
for (const [name, frameId, bodyId] of [['bodyEd', ids.bodyEd, ids.bodyText], ['design', ids.design, ids.designText]]) {
  await call('click', { id: frameId, quiet: true });
  r = await call('type', { text: 'ok', exact: true, expect_focus: bodyId, quiet: true });
  const r2 = await call('type', { text: '!', exact: true, expect_focus: frameId, quiet: true });
  const got = await js(`document.getElementById('${name}').contentDocument.body.textContent`);
  check(!/Nothing sent/.test(r.text) && !/Nothing sent/.test(r2.text) && got === 'ok!', `the ${name} frame's editable body has the focus, by its own id and by its frame's (${JSON.stringify(got)})`);
}

// An element in a frame of another site cannot be checked: refused at once.
await call('click', { id: ids.far, quiet: true });
// The far frame's own keys reach its server: one probe key shows the
// reporting works, so a zero below means something.
await call('press', { keys: 'x', quiet: true });
await new Promise((res) => setTimeout(res, 500));
const probe = farKeys;
await noKeys();
r = await call('type', { text: 'x', exact: true, expect_focus: ids.far });
seen = await keysSeen();
check(probe >= 1 && r.isError && /frame of another site.*Leave expect_focus out/.test(r.text) && seen.none, `expect_focus on an element in a frame of another site is refused; no key reached it (probe key counted ${probe}, ${JSON.stringify(seen)})`);

// A frame of the same process that the check's world cannot read (an opaque
// origin): refused with that reason, not as gone.
for (const [name, fid] of [['data:', dataField], ['sandboxed', sandField]]) {
  if (!fid) {
    check(false, `the ${name} frame's field is listed with an id, so its refusal can be checked`);
    continue;
  }
  r = await call('click', { id: fid, quiet: true });
  await call('press', { keys: 'x', quiet: true });
  const frameProbe = (await keysSeen()).frames;
  await noKeys();
  r = await call('type', { text: 'x', exact: true, expect_focus: fid });
  seen = await keysSeen();
  console.log(`  ${name} frame: ${r.text.split('\n')[0]}`);
  const readable = /cannot read the frame .* is in .*Leave expect_focus out/.test(r.text);
  const otherProcess = /frame of another site/.test(r.text);
  check(frameProbe >= 1 && (readable || otherProcess) && !/no longer on the page/.test(r.text) && seen.none, `expect_focus in the ${name} frame is refused for the frame, not as gone (${readable ? 'same process, unreadable' : otherProcess ? 'another process' : 'neither'}); no key reached it (probe ${frameProbe}, ${JSON.stringify(seen)})`);
}

// Cancellation: a burst stops sending when the request is cancelled, and no
// submit Enter follows.
await call('click', { id: ids.notes, quiet: true });
await call('eval_js', { expression: "document.getElementById('ta').value = ''; window.__keys.length = 0" });
const ac = new AbortController();
const t0 = Date.now();
const cancelled = call('type', { keys: ['ab', { pause_ms: 6000 }, 'cd'], submit: true }, ac.signal).then(
  () => 'answered',
  (e) => `rejected: ${e.message}`,
);
await new Promise((res) => setTimeout(res, 2500));
ac.abort();
const how = await cancelled;
await new Promise((res) => setTimeout(res, 6000));
const after = await js(`[document.getElementById('ta').value, window.__keys]`);
check(
  /rejected/.test(how) && after[0] === 'ab' && !after[1].includes('c') && !after[1].includes('Enter'),
  `a cancelled burst sent nothing after the cancel, and no Enter (${JSON.stringify(after)}, ${Date.now() - t0} ms, the call ${how})`,
);
r = await call('observe');
check(!r.isError, 'the server answers after a cancelled call');

// A drag whose drop target leaves the page on the press: the browser's drag
// answers gone and lets go where it pressed (measured: the page sees the
// mouseup at the press point); the next click works.
await call('eval_js', { expression: 'window.__mouse.down = 0; window.__mouse.up = 0; window.__armGone = true' });
const from = await js(`(() => { const b = document.getElementById('words').getBoundingClientRect(); return { x: b.left + 10, y: b.top + b.height / 2 }; })()`);
r = await call('drag', { from_x: from.x, from_y: from.y, to: ids.gone });
const m = await js('window.__mouse');
console.log(`  answer: ${r.text.replace(/\n+/g, ' | ')}`);
check(/^Not dragged: gone, .*\(let go where it was grabbed\)\.$/.test(r.text) && m.down === 1 && m.up === 1, `a drag whose target left on the press was answered gone, and the page saw the button come up (downs ${m.down}, ups ${m.up})`);
await call('eval_js', { expression: 'window.__mouse.down = 0; window.__mouse.up = 0; window.__armGone = false' });
r = await call('click', { x: from.x, y: from.y, quiet: true });
const mc = await js('window.__mouse');
check(!r.isError && /^Clicked at/.test(r.text) && mc.down === 1 && mc.up === 1, `the next click went through (downs ${mc.down}, ups ${mc.up})`);

// A drag from a point on a draggable element: the page takes the press as a
// native drag of its own, and the answer says so, as the page saw it (a
// dragstart and a drop on the zone); the next click goes through.
await call('eval_js', { expression: 'window.__dnd.length = 0' });
const dm = await js(`(() => { const a = document.getElementById('dragme').getBoundingClientRect(); const b = document.getElementById('dropzone').getBoundingClientRect(); return { fx: a.left + 20, fy: a.top + a.height / 2, tx: b.left + b.width / 2, ty: b.top + b.height / 2 }; })()`);
r = await call('drag', { from_x: dm.fx, from_y: dm.fy, x: dm.tx, y: dm.ty });
const dnd = await js('window.__dnd');
console.log(`  native drag: answer "${r.text.split('\n')[0]}"; page saw ${JSON.stringify(dnd)}`);
check(/^Dragged from .* \(native drag, dropped\)\.\nThe page took the press as a native drag/.test(r.text) && dnd.includes('dragstart:dragme') && dnd.includes('drop:dropzone'), `a native drag from a point was answered as one (the page saw ${JSON.stringify(dnd)})`);
await call('eval_js', { expression: 'window.__mouse.down = 0; window.__mouse.up = 0' });
r = await call('click', { x: from.x, y: from.y, quiet: true });
const mn = await js('window.__mouse');
check(/^Clicked at/.test(r.text) && mn.down === 1 && mn.up === 1, `the click after it went through (${r.text.split('\n')[0]}; downs ${mn.down}, ups ${mn.up})`);

// fetch with save_to: a binary body, an existing file refused, a text body.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cph-save-'));
const bin = path.join(dir, 'body.bin');
r = await call('fetch', { url: `${base}/bin`, save_to: bin });
check(/Body saved to/.test(r.text) && fs.existsSync(bin) && fs.readFileSync(bin).toString('hex') === '000102fafbfcfdfeff', 'a binary body landed in the named file');
fs.writeFileSync(path.join(dir, 'keep.bin'), 'keep');
r = await call('fetch', { url: `${base}/bin`, save_to: path.join(dir, 'keep.bin') });
check(r.isError && /already exists/.test(r.text) && fs.readFileSync(path.join(dir, 'keep.bin'), 'utf8') === 'keep', 'an existing file is refused and left as it was');
const txt = path.join(dir, 'body.txt');
r = await call('fetch', { url: `${base}/txt`, save_to: txt });
check(/Saved the response's text to .*body\.txt/.test(r.text) && fs.existsSync(txt) && fs.readFileSync(txt, 'utf8') === 'hello text body', 'a small text body was written to the named file, and the answer says it is the text');
// A folder that cannot be made (its parent is a file): refused before the
// request reaches the server.
fs.writeFileSync(path.join(dir, 'afile'), 'x');
saveHits = 0;
const blocked = path.join(dir, 'afile', 'sub', 'out.txt');
r = await call('fetch', { url: `${base}/count`, method: 'POST', body: 'once', save_to: blocked });
check(r.isError && /cannot be made.*Nothing was fetched/.test(r.text) && saveHits === 0, `save_to in a folder that cannot be made was refused before the request (requests ${saveHits})`);
r = await call('fetch', { url: `${base}/count`, method: 'POST', body: 'once' });
check(saveHits === 1, `the counting server counts a request that does go out (${saveHits})`);
// A folder that does not exist yet is made.
const deep = path.join(dir, 'new', 'deeper', 'page.md');
r = await call('fetch', { url: `${base}/article`, save_to: deep });
const md = fs.existsSync(deep) ? fs.readFileSync(deep, 'utf8') : '';
check(/Saved the page rendered as Markdown .*page\.md/.test(r.text) && /Saved heading/.test(md) && !/<h1>/.test(md) && /Saved heading/.test(r.text), `an HTML page was saved as Markdown in a new folder, the answer says so and carries the page (${JSON.stringify(md.slice(0, 60))})`);
const raw = path.join(dir, 'page.html');
r = await call('fetch', { url: `${base}/article`, mode: 'raw', save_to: raw });
const rawText = fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : '';
check(/Saved the response's text/.test(r.text) && /<h1>Saved heading<\/h1>/.test(rawText), 'with mode raw the HTML is saved as it came');
fs.rmSync(dir, { recursive: true, force: true });

await call('browser_close');
await client.close();
site.close();
other.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
