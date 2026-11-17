// The Google Docs editor module (src/editors/docs.ts) on a local page that
// imitates Docs' signature: a canvas of class kix-canvas-tile-content drawn
// as canvas_text.mjs's page draws (each string in U+202D … U+202C, formats as
// runs of their own, the space between them a gap), a .kix-cursor holding
// #kix-current-user-cursor-caret placed at a boundary the page computes with
// measureText, and selection fills in Docs' two colours. Checks the caret
// line inside a run, on both sides of a joined space, at a line's start and
// end and on an empty line; the selection inside one line, across two lines,
// to a line's end (and stopping at its last run), focused and unfocused;
// neither; the lines at the end of an action's answer, plain and quiet; and
// that a page without the signature, with the same canvas and caret, gets no
// such line. On a browser that predates canvas text: no line, one SKIP.
// Usage: node test/docs_editor.mjs [server.mjs]
// (CHROMAPHORE_TEST_BROWSER names the chrome.exe; else the installed release.)
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = process.argv[2] ?? path.resolve(here, '../../plugin/dist/server.mjs');

const pageOf = (cls) => `<!doctype html><meta charset="utf-8"><title>doc</title>
<style>body{margin:0;font:14px Arial} #top{height:60px} canvas{display:block;margin-left:30px}
.kix-cursor{position:absolute;left:0;top:0;pointer-events:none} #kix-current-user-cursor-caret{position:absolute;width:2px;background:#000}</style>
<div id="top"><button id="noop">Nothing</button></div>
<canvas class="${cls}" width="700" height="300" style="width:700px;height:300px"></canvas>
<div class="kix-cursor"><div id="kix-current-user-cursor-caret"></div></div>
<script>
const c = document.querySelector('canvas');
const ctx = c.getContext('2d');
const X0 = 40, LH = 24, TOP = 30, FONT = '16px Arial';
const W = (s) => '\\u202D' + s + '\\u202C';
const doc = [
  [['Plain', FONT], ['words', 'bold ' + FONT], ['here.', FONT]],
  [['Second line of text', FONT]],
  [],
  [['Fourth line', FONT]],
];
window.layout = [];
function drawAll() {
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  doc.forEach((line, i) => {
    let x = X0;
    const y = TOP + i * LH;
    window.layout[i] = [];
    line.forEach(([t, f], k) => {
      ctx.font = FONT;
      if (k > 0) x += ctx.measureText(' ').width;
      ctx.font = f;
      ctx.fillStyle = '#000';
      ctx.fillText(W(t), x, y);
      window.layout[i].push({ t, f, x, y });
      x += ctx.measureText(W(t)).width;
    });
  });
}
drawAll();
ctx.font = FONT;
const M = ctx.measureText('Hg');
const ASC = M.fontBoundingBoxAscent, DESC = M.fontBoundingBoxDescent;
window.spaceWidth = ctx.measureText(' ').width;
// Boundary n of run k of line i, in the view: its x, and the top and height
// of the line's box.
window.spot = (i, k, n) => {
  const r = window.layout[i][k];
  ctx.font = r.f;
  const w = ctx.measureText(W(r.t).slice(0, n + 1)).width;
  const b = c.getBoundingClientRect();
  return { x: b.left + r.x + w, top: b.top + r.y - ASC, height: ASC + DESC };
};
window.lineTop = (i) => c.getBoundingClientRect().top + TOP + i * LH - ASC;
const cursor = document.querySelector('.kix-cursor');
const caret = document.getElementById('kix-current-user-cursor-caret');
window.caretAt = (x, top, height) => {
  cursor.style.display = '';
  Object.assign(caret.style, { left: x + 'px', top: top + 'px', height: height + 'px' });
};
window.caretAtSpot = (i, k, n) => { const s = window.spot(i, k, n); window.caretAt(s.x, s.top, s.height); };
window.noCaret = () => { cursor.style.display = 'none'; };
// A selection as Docs draws it: one fill per line, [x0, x1, line] in view
// coordinates, over the line's box and a little more.
window.select = (parts, focused) => {
  window.noCaret();
  drawAll();
  const b = c.getBoundingClientRect();
  ctx.fillStyle = focused ? 'rgba(78, 143, 248, 0.5)' : 'rgba(143, 143, 143, 0.34)';
  for (const [x0, x1, i] of parts) ctx.fillRect(x0 - b.left, TOP + i * LH - ASC - 2, x1 - x0, ASC + DESC + 4);
};
window.noSelection = () => drawAll();
</script>`;
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageOf(req.url === '/plain' ? 'plain-canvas' : 'kix-canvas-tile-content'));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const env = { ...process.env };
delete env.CLAUDE_CODE_SESSION_ID;
delete env.CHROMAPHORE_BROWSER;
delete env.CHROMAPHORE_REPLAY_OPTIONS;
if (process.env.CHROMAPHORE_TEST_BROWSER) env.CHROMAPHORE_BROWSER = process.env.CHROMAPHORE_TEST_BROWSER;
const client = new Client({ name: 'docs-editor-test', version: '0' });
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
  return { text, isError: !!r.isError };
}
// The Docs lines of an answer.
const docsOf = (text) => text.split('\n').filter((l) => /^Docs( caret| selection)?:/.test(l));
// An answer without the snapshot id that follows its text.
const bodyOf = (text) => text.replace(/\n\nsnapshot_id .*$/s, '');
const observeDocs = async () => {
  const lines = docsOf((await call('observe')).text);
  console.log(`    ${JSON.stringify(lines)}`);
  return lines;
};
const one = (lines, want) => lines.length === 1 && lines[0] === want;
const finish = async () => {
  await call('browser_close');
  await client.close();
  site.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
};

let r = await call('browser_open', { profile: 'temp', headless: true, url: base });
const modern = !/predates/.test((await call('clipboard')).text);
console.log(`  browser: ${modern ? 'has canvas text' : 'predates canvas text'}`);
const noop = /^([a-z]+\d+) button "Nothing"/m.exec(r.text)?.[1];

if (!modern) {
  await call('eval_js', { expression: 'caretAtSpot(1, 0, 6)' });
  r = await call('observe');
  check(docsOf(r.text).length === 0 && !/Canvas text/.test(r.text), 'observe on a Docs-like page has no Docs line and no canvas text');
  r = await call('click', { id: noop, quiet: true });
  check(!r.isError && docsOf(r.text).length === 0, 'an action answers without a Docs line');
  console.log('SKIP the Docs caret and selection lines: this browser predates Page.agentCanvasText (a Chromaphore build newer than release 2.0.0 has it)');
  await finish();
}

// The whole text, as part A's flow joins the lines.
const ALL = 'Plain words here. Second line of text Fourth line';
check(docsOf(r.text).length === 1, `navigate's answer ends with a Docs line (${JSON.stringify(docsOf(r.text))})`);

// The caret.
await call('eval_js', { expression: 'caretAtSpot(1, 0, 6)' });
let d = await observeDocs();
check(one(d, 'Docs caret: after "Plain words here. Second" and before " line of text Fourth line".'), 'a caret inside a run is told by the text on each side');
await call('eval_js', { expression: 'caretAtSpot(0, 0, 5)' });
d = await observeDocs();
check(one(d, `Docs caret: after "Plain" and before ${JSON.stringify(ALL.slice(5, 45))}.`), 'a caret at the end of a run before a joined space: the space comes after it (40 characters each side)');
await call('eval_js', { expression: 'caretAtSpot(0, 1, 0)' });
d = await observeDocs();
check(one(d, `Docs caret: after "Plain " and before ${JSON.stringify(ALL.slice(6, 46))}.`), 'a caret at the start of the run after a joined space: the space comes before it');
await call('eval_js', { expression: 'caretAtSpot(1, 0, 0)' });
d = await observeDocs();
check(one(d, 'Docs caret: after "Plain words here. " and before "Second line of text Fourth line" (at the start of a line).'), "a caret at a line's start says so");
await call('eval_js', { expression: 'caretAtSpot(0, 2, 5)' });
d = await observeDocs();
check(one(d, 'Docs caret: after "Plain words here." and before " Second line of text Fourth line" (at the end of a line).'), "a caret at a line's end says so");
await call('eval_js', { expression: 'caretAtSpot(3, 0, 11)' });
d = await observeDocs();
check(one(d, `Docs caret: after ${JSON.stringify(ALL.slice(-40))} and before "" (at the end of a line).`), 'a caret at the end of the last line');
// An empty line: no text at the caret's height.
await call('eval_js', { expression: '(() => { const s = spot(1, 0, 0); caretAt(s.x, lineTop(2), s.height); })()' });
d = await observeDocs();
check(d.length === 1 && /^Docs caret: at \([\d.]+, [\d.]+\), on a line that holds no text in view \(an empty line\), after "Plain words here\. Second line of text " and before "Fourth line"\.$/.test(d[0]), 'a caret on an empty line is told with its place, between the lines around it');

// The selection: the caret is hidden while one shows.
const sel = async (parts, focused) => {
  await call('eval_js', { expression: `select(${parts}, ${focused})` });
  return observeDocs();
};
d = await sel('[[spot(1, 0, 7).x, spot(1, 0, 14).x, 1]]', true);
check(one(d, 'Docs selection: "line of" (7 characters as drawn, on 1 line(s)).'), 'a selection inside one line, focused');
d = await sel('[[spot(1, 0, 7).x, spot(1, 0, 14).x, 1]]', false);
check(one(d, 'Docs selection: "line of" (7 characters as drawn, on 1 line(s)). The document does not have the keyboard focus (the selection is drawn grey).'), 'the same selection drawn grey: the document lacks the focus');
d = await sel('[[spot(0, 1, 0).x, spot(0, 2, 5).x + spaceWidth, 0], [spot(1, 0, 0).x, spot(1, 0, 6).x, 1]]', true);
check(one(d, 'Docs selection: "words here.\\nSecond" (17 characters as drawn, on 2 line(s)). The space or break at the end of line 1 of it is selected too.'), "a selection across two lines, the first one's end included");
d = await sel('[[spot(3, 0, 7).x, spot(3, 0, 11).x + spaceWidth, 3]]', true);
check(one(d, 'Docs selection: "line" (4 characters as drawn, on 1 line(s)). The space or break at the end of its line is selected too.'), "a selection to a line's end, reaching a space past its last run");
d = await sel('[[spot(3, 0, 7).x, spot(3, 0, 11).x, 3]]', true);
check(one(d, 'Docs selection: "line" (4 characters as drawn, on 1 line(s)).'), "a selection that stops at the last run is not told to take the line's end");
d = await sel('[[spot(0, 0, 5).x, spot(0, 1, 5).x, 0]]', true);
check(one(d, 'Docs selection: " words" (6 characters as drawn, on 1 line(s)).'), "a selection from a run's end takes the joined space");

// Neither.
// The frame that takes Docs' keys: while it is in the page and something else
// has the focus, the caret line says the document lacks the keyboard.
await call('eval_js', { expression: "noSelection(); caretAtSpot(1, 0, 6); (() => { const f = document.createElement('iframe'); f.className = 'docs-texteventtarget-iframe'; f.id = 'keys'; f.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;border:0'; document.body.append(f); document.activeElement && document.activeElement.blur(); })()" });
d = await observeDocs();
check(one(d, 'Docs caret: after "Plain words here. Second" and before " line of text Fourth line". The document does not have the keyboard focus: keys would not go there.'), 'a caret drawn while the key target lacks the focus is told so');
await call('eval_js', { expression: "document.getElementById('keys').focus()" });
d = await observeDocs();
check(one(d, 'Docs caret: after "Plain words here. Second" and before " line of text Fourth line".'), 'with the key target focused the caret line has no such note');
await call('eval_js', { expression: "document.getElementById('keys').remove()" });
await call('eval_js', { expression: 'noSelection(); noCaret()' });
d = await observeDocs();
check(one(d, 'Docs: no caret and no selection show (the document does not have the keyboard focus, or they are out of view).'), 'no caret and no selection: one line says so');

// At the end of an action's answer, plain and quiet.
await call('eval_js', { expression: 'caretAtSpot(1, 0, 6)' });
for (const quiet of [false, true]) {
  r = await call('click', { id: noop, quiet });
  const last = bodyOf(r.text).split('\n').at(-1);
  check(!r.isError && last === 'Docs caret: after "Plain words here. Second" and before " line of text Fourth line".', `a ${quiet ? 'quiet' : 'plain'} action's answer ends with the caret line (${JSON.stringify(last)})`);
}

// A page without the signature, with the same canvas and caret: no line.
r = await call('navigate', { url: `${base}/plain` });
check(/Canvas text in view:/.test(r.text) && docsOf(r.text).length === 0, 'a page without the signature shows its canvas text and no Docs line');
await call('eval_js', { expression: 'caretAtSpot(1, 0, 6)' });
r = await call('observe');
check(/Canvas text in view:/.test(r.text) && docsOf(r.text).length === 0, 'observe there has no Docs line');
const noop2 = /^([a-z]+\d+) button "Nothing"/m.exec(r.text)?.[1];
r = await call('click', { id: noop2, quiet: true });
check(!r.isError && docsOf(r.text).length === 0, 'an action there has no Docs line');

await finish();
