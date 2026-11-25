// Canvas text and aiming by text, on a local page that draws as Google Docs
// does: each string wrapped in U+202D … U+202C, formats as runs of their own
// with the space between them not drawn, a changed line redrawn by clearing
// its band, clipping to it and drawing the neighbours again, and a selection
// as a translucent fillRect. Checks: the lines in observe; the changed lines
// after an action, and none for a selection drawn over the text; a scroll's
// summary; a click placed by text_before and text_after landing within half
// a pixel of the boundary's point, also on a joined space both ways and at a
// line's end; none and several matches refused with nothing moved; an id
// with text refused; hover by text; drag with select. On a browser that
// predates canvas text: the listing has no canvas section, aiming by text is
// refused with one sentence, and the rest is one SKIP line.
// Usage: node test/canvas_text.mjs [server.mjs]
// (CHROMAPHORE_TEST_BROWSER names the chrome.exe; else the installed release.)
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = process.argv[2] ?? path.resolve(here, '../../plugin/dist/server.mjs');

const page = `<!doctype html><meta charset="utf-8"><title>canvas doc</title>
<style>body{margin:0;font:14px Arial} #top{height:60px} canvas{display:block;margin-left:30px}</style>
<div id="top"><button id="edit">Edit line</button> <button id="sel">Select</button></div>
<canvas id="c" width="800" height="2400" style="width:800px;height:2400px"></canvas>
<script>
const c = document.getElementById('c');
const ctx = c.getContext('2d');
const X0 = 40, LH = 24, TOP = 30, FONT = '16px Arial';
const W = (s) => '\\u202D' + s + '\\u202C';
// Each line: runs [text, font, glued]; the space between two runs is not
// drawn, only left as a gap, unless the run is glued to the one before.
window.doc = [
  [['Plain', FONT], ['“quotes”', FONT], ['and', FONT], ['bold', 'bold ' + FONT], ['words.', FONT]],
  [['Some', FONT], ['italics', 'italic ' + FONT], ['.', FONT, true]],
  [['The quick brown fox jumps over the lazy dog.', FONT]],
  [['A line that ends here', FONT]],
  [['and the next line goes on.', FONT]],
  [['the', FONT], ['end', FONT]],
];
for (let i = 0; i < 80; i++) window.doc.push([['Filler line number ' + (i + 1) + ' of the long document.', FONT]]);
window.layout = [];
function drawLine(i) {
  let x = X0;
  const y = TOP + i * LH;
  const runs = [];
  window.doc[i].forEach(([t, f, glued], k) => {
    ctx.font = FONT;
    if (k > 0 && !glued) x += ctx.measureText(' ').width;
    ctx.font = f;
    ctx.fillStyle = '#000';
    ctx.fillText(W(t), x, y);
    const w = ctx.measureText(W(t)).width;
    runs.push({ t, f, x, y });
    x += w;
  });
  window.layout[i] = runs;
}
ctx.fillStyle = '#fff';
ctx.fillRect(0, 0, c.width, c.height);
for (let i = 0; i < window.doc.length; i++) drawLine(i);
// A changed line drawn again as Docs does: clear its band, clip to it, draw
// the neighbours and the line.
function redraw(i) {
  const top = TOP + i * LH - 18;
  ctx.save();
  ctx.clearRect(0, top, c.width, LH);
  ctx.beginPath();
  ctx.rect(0, top, c.width, LH);
  ctx.clip();
  for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < window.doc.length) drawLine(j);
  ctx.restore();
}
document.getElementById('edit').onclick = () => { window.doc[3] = [['A line that was edited', FONT]]; redraw(3); };
document.getElementById('sel').onclick = () => { const r = window.layout[2][0]; ctx.fillStyle = 'rgba(78, 143, 248, 0.5)'; ctx.fillRect(r.x, r.y - 15, 80, 20); };
window.__down = [];
window.__up = [];
window.__moves = 0;
window.__last = null;
c.addEventListener('pointerdown', (e) => window.__down.push({ x: e.clientX, y: e.clientY }));
addEventListener('pointerup', (e) => window.__up.push({ x: e.clientX, y: e.clientY }));
addEventListener('pointermove', (e) => { window.__moves++; window.__last = { x: e.clientX, y: e.clientY }; });
// Where boundary n of run k of line i is in the view, at the middle of the
// font's box in height (its ascent above the baseline, its descent below).
window.pointOf = (i, k, n) => {
  const r = window.layout[i][k];
  ctx.font = r.f;
  const m = ctx.measureText(W(r.t).slice(0, n + 1));
  const b = c.getBoundingClientRect();
  return { x: b.left + r.x + m.width, y: b.top + r.y - (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2 };
};
</script>`;
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const env = { ...process.env };
delete env.CLAUDE_CODE_SESSION_ID;
delete env.CHROMAPHORE_BROWSER;
delete env.CHROMAPHORE_REPLAY_OPTIONS;
if (process.env.CHROMAPHORE_TEST_BROWSER) env.CHROMAPHORE_BROWSER = process.env.CHROMAPHORE_TEST_BROWSER;
const client = new Client({ name: 'canvas-test', version: '0' });
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
const js = async (expression) => JSON.parse((await call('eval_js', { expression: `JSON.stringify(${expression})` })).text);
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

if (!modern) {
  // An older browser: the listing as before, aiming by text refused plainly.
  check(!/Canvas text/.test(r.text), 'the listing has no canvas text section');
  const editId = /^([a-z]+\d+) button "Edit line"/m.exec(r.text)?.[1];
  r = await call('click', { id: editId, quiet: true });
  check(!r.isError && !/Canvas text/.test(r.text), 'an action answers without canvas text');
  for (const [tool, args] of [['click', { text_after: 'Plain' }], ['hover', { text_before: 'Plain' }], ['drag', { select: 'Plain' }]]) {
    r = await call(tool, args);
    check(r.isError && /^This browser predates (aiming|selecting) by text: it needs a Chromaphore build newer than release 2\.0\.0\. Nothing was done\.$/.test(r.text), `${tool} by text is refused in one sentence (${r.text})`);
  }
  console.log('SKIP canvas text in the listing, its changes and aiming by text: this browser predates Page.agentCanvasText (a Chromaphore build newer than release 2.0.0 has it)');
  await finish();
}

// The lines, as they read: format characters gone, runs joined by a space
// where the page left a gap, glued where it did not, top to bottom.
r = await call('observe');
const section = r.text.slice(r.text.indexOf('Canvas text in view:'));
console.log(section.split('\n').slice(0, 9).join('\n'));
const want = ['  Plain “quotes” and bold words.', '  Some italics.', '  The quick brown fox jumps over the lazy dog.', '  A line that ends here', '  and the next line goes on.', '  the end', '  Filler line number 1 of the long document.'];
const got = section.split('\n').slice(1, 1 + want.length);
check(r.text.includes('Canvas text in view:') && JSON.stringify(got) === JSON.stringify(want), `observe ends with the canvas lines as they read (${JSON.stringify(got.slice(0, 3))})`);
check(!/[\u202a-\u202e]/.test(section), 'no format character is shown');
check(!/not exact/.test(section), 'the runs are exact, so no caution line (the background fill a clear cut into does not count)');
const ids = r.text;
const editId = /^([a-z]+\d+) button "Edit line"/m.exec(ids)?.[1];
const selId = /^([a-z]+\d+) button "Select"/m.exec(ids)?.[1];

// A changed line, redrawn with its neighbours: only it is told.
r = await call('click', { id: editId });
const changed = r.text.slice(r.text.indexOf('Canvas text changed:'));
check(/Canvas text changed:\n {2}- A line that ends here\n {2}\+ A line that was edited(\n|$)/.test(r.text) && changed.split('\n').filter((l) => /^ {2}[+-] /.test(l)).length === 2, `the action's answer gives the changed line only (${JSON.stringify(changed.split('\n').slice(0, 4))})`);
// A selection drawn over text changes no line.
r = await call('click', { id: selId, quiet: true });
check(!r.isError && !/Canvas text/.test(r.text), 'a translucent selection over the text is no change (quiet answer)');

// A scroll changes many lines: one summary line.
r = await call('scroll', { direction: 'down', amount: 400, quiet: true });
const summary = /Canvas text in view changed: (\d+) line\(s\) show now, from "([^"]*)" to "([^"]*)"\./.exec(r.text);
console.log(`  ${summary?.[0]}`);
check(!!summary && /^Filler line number \d+ of the long document\.$/.test(summary[2]) && !/^ {2}[+-] /m.test(r.text), 'a scroll is told as one summary line: how many lines show, the first and the last');
r = await call('scroll', { direction: 'up', amount: 2000, quiet: true });
check(/Canvas text in view changed: \d+ line\(s\) show now, from "Plain “quotes” and bold words\."/.test(r.text), 'scrolling back is told the same way');

const near = (a, b) => !!a && !!b && Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5;
const reset = () => call('eval_js', { expression: 'window.__down.length = 0; window.__up.length = 0; window.__moves = 0' });
const lastDown = () => js('window.__down.at(-1) ?? null');

// A click between two runs the page drew with a gap: "Plain " then
// "“quotes”" puts the space before the place, so it is the start of the
// run after it.
await reset();
let want1 = await js('pointOf(0, 1, 0)');
r = await call('click', { text_before: 'Plain ', text_after: '“quotes”', quiet: true });
let down = await lastDown();
check(/^Clicked between "Plain " and "“quotes”" at \(\d+(\.\d)?, \d+(\.\d)?\)\.$/m.test(r.text), `the answer names the place by its text (${r.text.split('\n')[0]})`);
check(near(down, want1), `the click landed within half a pixel of the start of "“quotes”" (${JSON.stringify(down)} against ${JSON.stringify(want1)})`);
// The same gap with the space after the place: the end of "Plain".
await reset();
want1 = await js('pointOf(0, 0, 5)');
r = await call('click', { text_before: 'Plain', text_after: ' “quotes”', quiet: true });
down = await lastDown();
check(!r.isError && near(down, want1), `with the space after the place, the end of "Plain" (${JSON.stringify(down)} against ${JSON.stringify(want1)})`);
// Inside a run, and with text_after alone.
await reset();
want1 = await js('pointOf(2, 0, 4)');
r = await call('click', { text_after: 'quick brown', quiet: true });
down = await lastDown();
check(!r.isError && /^Clicked before "quick brown"/.test(r.text) && near(down, want1), `text_after alone: before "quick" (${JSON.stringify(down)} against ${JSON.stringify(want1)})`);
// A line's end: the space between two lines, after the place, and before it.
await reset();
want1 = await js('pointOf(3, 0, 22)');
r = await call('click', { text_before: 'was edited', text_after: '\nand the next', quiet: true });
down = await lastDown();
check(!r.isError && near(down, want1), `a line break after the place is the end of the line before (${JSON.stringify(down)} against ${JSON.stringify(want1)})`);
await reset();
want1 = await js('pointOf(4, 0, 0)');
r = await call('click', { text_before: 'was edited ', text_after: 'and the next', quiet: true });
down = await lastDown();
check(!r.isError && near(down, want1), `a space before the place is the start of the line after (${JSON.stringify(down)} against ${JSON.stringify(want1)})`);
// Two runs glued with no gap: "italics" then ".".
await reset();
want1 = await js('pointOf(1, 2, 0)');
r = await call('click', { text_before: 'italics', text_after: '.', quiet: true });
down = await lastDown();
check(!r.isError && Math.abs(down.x - want1.x) <= 0.5, `between two glued runs (${JSON.stringify(down)} against ${JSON.stringify(want1)})`);

// No place, and several places: refused, nothing moves.
await reset();
r = await call('click', { text_before: 'zebra' });
let moved = await js('[window.__moves, window.__down.length]');
check(r.isError && /^No place in the canvas text in view reads "zebra"\. Nothing was done\. Scroll it into view/.test(r.text) && moved[0] === 0 && moved[1] === 0, `no match is refused before anything moves (${r.text.split('\n')[0]}; moves ${moved})`);
r = await call('click', { text_after: 'the ' });
moved = await js('[window.__moves, window.__down.length]');
const several = /^(\d+) places in the canvas text in view read "the "\. Nothing was done\. Give more text around it/.exec(r.text);
check(r.isError && !!several && Number(several[1]) > 2 && moved[0] === 0 && moved[1] === 0, `several matches are refused with their count, nothing moved (${r.text.split('\n')[0]})`);
r = await call('click', { text_before: 'Plain', text_after: '  \u00a0“quotes”', quiet: true });
check(!r.isError, 'any run of whitespace in the caller\'s text counts as one space');
r = await call('click', { id: editId, text_after: 'Plain' });
check(r.isError && /one of them/.test(r.text), 'an id together with text is refused');
r = await call('click', { x: 10, y: 10, text_after: 'Plain' });
check(r.isError && /one of them/.test(r.text), 'a point together with text is refused');

// Hover by text.
r = await call('hover', { text_after: 'bold' });
const last = await js('window.__last');
want1 = await js('pointOf(0, 3, 0)');
check(/^The pointer is before "bold" at /.test(r.text) && near(last, want1), `hover by text ended at the place (${JSON.stringify(last)} against ${JSON.stringify(want1)})`);

// A drag over the text to select, with its context: pressed at its start,
// let go at its end.
await reset();
const from = await js('pointOf(2, 0, 4)');
const to = await js('pointOf(2, 0, 15)');
r = await call('drag', { select: 'quick brown', text_before: 'The ', quiet: true });
const d = await js('[window.__down.at(-1) ?? null, window.__up.at(-1) ?? null]');
check(/^Dragged over "quick brown" from \(.*\) to \(.*\) \(pointer drag, released\)\./.test(r.text) && near(d[0], from) && near(d[1], to), `drag with select pressed at the start and let go at the end (${JSON.stringify(d)} against ${JSON.stringify([from, to])})`);
r = await call('drag', { select: 'the' });
check(r.isError && /places in the canvas text in view read "the"/.test(r.text), 'drag with select that reads so in several places is refused');
r = await call('drag', { select: 'Plain', from_x: 5, from_y: 5 });
check(r.isError && /select is a drag of its own/.test(r.text), 'select with a start point is refused');

// Out of view: the text is not in the view's canvas text, so nothing reads so.
r = await call('click', { text_after: 'Filler line number 70 ' });
check(r.isError && /^No place in the canvas text in view reads/.test(r.text), 'text below the view is not found (scroll it into view)');

// After observe with offscreen "none", a quiet action stays comparable and
// reports its canvas change lines.
await call('eval_js', { expression: "window.doc[3] = [['Before offscreen none', FONT]]; redraw(3);" });
await call('observe', { offscreen: 'none' });
r = await call('click', { id: editId, quiet: true });
check(
  !/not comparable/.test(r.text) && /Canvas text changed:/.test(r.text),
  `quiet action after observe(offscreen: "none") is comparable and shows canvas change (${r.text.replace(/\n+/g, ' | ')})`,
);

await finish();
