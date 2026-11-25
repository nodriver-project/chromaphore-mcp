// Points, bursts and the focus check, on a local page, with the replay
// options setting off (the general features; test/replay_options.mjs has
// not_before, seed and the burst text check): a click at a point between two
// characters puts the caret there, a drag between two points selects what
// lies between, Shift-click and double click work at points, a scripted
// burst leaves its text (Backspaces, a shortcut, a pause), expect_focus
// refuses keys while another element has the focus (also inside a
// same-origin frame, as Google Docs takes keys), quiet leaves the element
// lines out, and speed changes the pace. Also: a press whose key is not ASCII
// is refused before any key. A drag from a point is the browser's own drag:
// one press and one release, Shift held through it, onto an element (also
// one below the view, which the browser scrolls to), and a press on text
// already selected is answered as a native drag.
// Usage: node test/points_and_bursts.mjs [server.mjs]
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = process.argv[2] ?? path.resolve(here, '../../plugin/dist/server.mjs');

const page = `<!doctype html><meta charset="utf-8"><title>points</title>
<style>body{font:20px/30px Arial;margin:40px} #ed{width:700px;border:1px solid #888;padding:10px} iframe{width:400px;height:60px}</style>
<div id="ed" contenteditable="true"><p>Alpha bravo charlie delta echo.</p><p>Hotel india juliet kilo lima.</p></div>
<input id="other" aria-label="Other field">
<iframe id="sink" title="Key sink" srcdoc="<div contenteditable=true role=textbox aria-label='Frame field' style='min-height:30px'></div>"></iframe>
<div><button id="add" onclick="const b = document.createElement('button'); b.textContent = 'Row ' + (++window.__rows); document.body.appendChild(b)">Add row</button>
<span id="hov" style="display:inline-block;width:120px;height:30px;background:#ddf" onmouseover="window.__hover++">Hover box</span>
<span id="drop" role="button" aria-label="Drop here" style="display:inline-block;width:120px;height:30px;background:#fdd">Drop here</span>
<textarea id="ta" aria-label="Notes" rows="2"></textarea></div>
<div style="height:3000px"></div>
<button id="below">Far below</button>
<script>
window.__keys = [];
window.__rows = 0;
window.__hover = 0;
window.__mouse = { move: 0, down: 0, up: 0, upOn: [], shift: [] };
window.__dnd = [];
document.addEventListener('keydown', (e) => window.__keys.push({ key: e.key, t: Date.now(), ts: e.timeStamp }), true);
document.addEventListener('mousemove', () => window.__mouse.move++, true);
document.addEventListener('mousedown', (e) => { window.__mouse.down++; window.__mouse.shift.push(e.shiftKey); }, true);
for (const t of ['dragstart', 'drop', 'dragend']) document.addEventListener(t, () => window.__dnd.push(t), true);
document.addEventListener('mouseup', (e) => { window.__mouse.up++; window.__mouse.upOn.push(e.target.id || e.target.tagName); }, true);
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
// The browser under test: CHROMAPHORE_TEST_BROWSER, else the installed release.
if (process.env.CHROMAPHORE_TEST_BROWSER) env.CHROMAPHORE_BROWSER = process.env.CHROMAPHORE_TEST_BROWSER;
delete env.CHROMAPHORE_REPLAY_OPTIONS;
console.log('replay_options: off (CHROMAPHORE_REPLAY_OPTIONS unset)');
const client = new Client({ name: 'points-test', version: '0' });
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
// The left edge of character i of paragraph p, and the line's middle.
const charAt = (p, i) =>
  js(`(() => { const t = document.querySelectorAll('#ed p')[${p}].firstChild; const r = document.createRange(); r.setStart(t, ${i}); r.setEnd(t, ${i + 1}); const b = r.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2 }; })()`);
const selection = () => js(`(() => { const s = getSelection(); return { text: s.toString(), at: s.anchorOffset, focus: s.focusOffset, collapsed: s.isCollapsed }; })()`);
// An editable turns a space it cannot show into a no-break space.
const para = (p) => js(`document.querySelectorAll('#ed p')[${p}].textContent.replace(/ /g, ' ')`);

let r = await call('browser_open', { profile: 'temp', headless: true, url: base });
const listing = r.text;
const idOf = (role, name) => new RegExp(`^([a-z]+\\d+) ${role} "${name}"`, 'm').exec(listing)?.[1];

// A click between "Alpha " and "bravo" (index 6).
let p = await charAt(0, 6);
r = await call('click', { x: p.x, y: p.y });
let s = await selection();
check(!r.isError && s.collapsed && s.at === 6, `a click at a point put the caret between two characters (offset ${s.at})`);

// A drag from "Hotel|" (5) to "kilo|" (23) selects " india juliet kilo":
// the browser's pointer drag, one press and one release.
const resetMouse = () => call('eval_js', { expression: 'window.__mouse.down = 0; window.__mouse.up = 0; window.__mouse.upOn = []; window.__mouse.shift = []; window.__dnd.length = 0' });
await resetMouse();
const a = await charAt(1, 5);
const z = await charAt(1, 23);
r = await call('drag', { from_x: a.x, from_y: a.y, x: z.x, y: z.y });
s = await selection();
let m1 = await js('window.__mouse');
check(!r.isError && s.text === ' india juliet kilo', `a drag between two points selected ${JSON.stringify(s.text)}`);
check(/^Dragged from \(.*\) to \(.*\) \(pointer drag, released\)\./.test(r.text) && m1.down === 1 && m1.up === 1, `it was answered as a pointer drag, released, and the page saw one press and one release (${r.text.split('\n')[0]}; downs ${m1.down}, ups ${m1.up})`);
// Across two lines: from "charlie|" (19) of the first paragraph to "Hotel|" (5).
await call('eval_js', { expression: 'getSelection().removeAllRanges()' });
const a2 = await charAt(0, 19);
const z2 = await charAt(1, 5);
r = await call('drag', { from_x: a2.x, from_y: a2.y, x: z2.x, y: z2.y, quiet: true });
s = await selection();
check(!r.isError && s.text.replace(/\s+/g, ' ') === ' delta echo. Hotel', `a drag across two lines selected ${JSON.stringify(s.text)}`);

// With Shift held: the caret at "|Alpha", then a Shift drag from "Alpha |"
// (6) to "bravo|" (11) extends from the caret, so the selection is "Alpha
// bravo"; without Shift it would be "bravo".
p = await charAt(0, 0);
await call('click', { x: p.x, y: p.y, quiet: true });
await resetMouse();
const a3 = await charAt(0, 6);
const z3 = await charAt(0, 11);
r = await call('drag', { from_x: a3.x, from_y: a3.y, x: z3.x, y: z3.y, modifiers: ['Shift'], quiet: true });
s = await selection();
m1 = await js('window.__mouse');
check(!r.isError && s.text === 'Alpha bravo' && m1.shift.length === 1 && m1.shift[0] === true, `a Shift drag extended the selection to ${JSON.stringify(s.text)}, the press carrying Shift (${JSON.stringify(m1.shift)})`);

// Shift-click extends from the caret; a double click takes a word.
p = await charAt(0, 0);
await call('click', { x: p.x, y: p.y });
p = await charAt(0, 5);
await call('click', { x: p.x, y: p.y, modifiers: ['Shift'] });
s = await selection();
check(s.text === 'Alpha', `Shift-click at a point extended the selection to ${JSON.stringify(s.text)}`);
p = await charAt(0, 14);
await call('click', { x: p.x + 2, y: p.y, count: 2 });
s = await selection();
check(s.text.trim() === 'charlie', `a double click at a point took the word ${JSON.stringify(s.text)}`);

// A point outside the view is refused before anything moves.
r = await call('click', { x: 99999, y: 10 });
check(r.isError && /outside the view/.test(r.text), 'a point outside the view is refused');
r = await call('click', { id: 'a1', x: 5, y: 5 });
check(r.isError && /not both/.test(r.text), 'an id and a point together are refused');

// A burst at the end of the second paragraph; the answer says what it leaves.
p = await charAt(1, 28);
await call('click', { x: p.x + 14, y: p.y });
r = await call('type', {
  keys: [' Mike nvo', { bs: 2 }, 'ovember', { press: 'Ctrl+B' }, ' bold', { press: 'Ctrl+B' }, { pause_ms: 400 }, '.'],
});
check(!r.isError && /it leaves " Mike november bold\."/.test(r.text) && !/Ran from/.test(r.text), `the burst's answer says what it leaves (${r.text.split('\n')[0]})`);
check((await para(1)) === 'Hotel india juliet kilo lima. Mike november bold.', `the burst left its text: ${JSON.stringify(await para(1))}`);
const bold = await js(`[...document.querySelectorAll('#ed p')[1].querySelectorAll('b, strong')].map(e => e.textContent).join('|')`);
check(bold.trim() === 'bold', `the shortcut in the burst made only " bold" bold (${JSON.stringify(bold)})`);
const keys = await js(`window.__keys.filter(k => k.key !== 'Shift' && k.key !== 'Control')`);
check(keys.filter((k) => k.key === 'Backspace').length === 2, 'the burst pressed Backspace twice');

// expect_focus: the frame's field has the focus, so keys meant for the editor
// are refused; keys for the frame's field go through.
r = await call('observe', { offscreen: 'full' });
const frameField = new RegExp('^([a-z]+\\d+) textbox "Frame field"', 'm').exec(r.text)?.[1];
const editor = new RegExp('^([a-z]+\\d+) textbox', 'm').exec(r.text)?.[1];
check(!!frameField && !!editor && frameField !== editor, `the editor (${editor}) and the frame's field (${frameField}) are listed`);
await call('click', { id: frameField });
r = await call('type', { text: 'no', exact: true, expect_focus: editor });
check(/^Nothing sent: .* does not have the keyboard focus/.test(r.text), 'expect_focus refused keys while the frame field had the focus');
r = await call('type', { text: 'yes', exact: true, expect_focus: frameField, quiet: true });
const inFrame = await js(`document.getElementById('sink').contentDocument.body.textContent`);
check(!/Nothing sent/.test(r.text) && inFrame === 'yes', `expect_focus let keys through to the focused field in a frame (${JSON.stringify(inFrame)})`);

// press with times leaves a person's gap between the presses.
p = await charAt(0, 3);
await call('click', { x: p.x, y: p.y, quiet: true });
await call('eval_js', { expression: 'window.__keys.length = 0' });
await call('press', { keys: 'ArrowLeft', times: 4 });
const lefts = await js(`window.__keys.filter(k => k.key === 'ArrowLeft').map(k => k.t)`);
const gaps = lefts.slice(1).map((t, i) => t - lefts[i]);
check(lefts.length === 4 && gaps.every((g) => g >= 50), `four presses with gaps of ${gaps.join(', ')} ms`);

// quiet counts the element changes it leaves out.
r = await call('observe', { offscreen: 'full' });
const ids = r.text;
const idIn = (re) => new RegExp(`^([a-z]+\\d+) ${re}`, 'm').exec(ids)?.[1];
const addButton = idIn('button "Add row"');
const notes = idIn('textbox "Notes"');
const dropHere = idIn('button "Drop here"');
check(!!addButton && !!notes && !!dropHere, `the new controls are listed (${addButton}, ${notes}, ${dropHere})`);
// An action right after observe with offscreen "full" stays comparable.
r = await call('click', { id: addButton, quiet: true });
check(/\d+ element change\(s\) not listed \(quiet\)/.test(r.text) && !/^\+ /m.test(r.text) && !/not comparable/.test(r.text), `quiet after observe(offscreen: "full") is comparable and counts changes (${r.text.replace(/\n+/g, ' | ')})`);
// And right after observe with offscreen "none".
await call('observe', { offscreen: 'none' });
r = await call('click', { id: addButton, quiet: true });
check(!/not comparable/.test(r.text), `quiet after observe(offscreen: "none") is comparable (${r.text.replace(/\n+/g, ' | ')})`);

// A pause in a burst shows in the page's key times; without it the gap is shorter.
const clearNotes = () => call('eval_js', { expression: "document.getElementById('ta').value = ''; window.__keys.length = 0" });
const keyTimes = () => js(`window.__keys.filter(k => k.key.length === 1).map(k => [k.key, k.ts])`);
await call('click', { id: notes, quiet: true });
await clearNotes();
await call('type', { keys: ['x', { pause_ms: 1200 }, 'y'], quiet: true });
let kt = await keyTimes();
const paused = kt.length === 2 ? kt[1][1] - kt[0][1] : -1;
await clearNotes();
await call('type', { keys: ['x', 'y'], quiet: true });
kt = await keyTimes();
const unpaused = kt.length === 2 ? kt[1][1] - kt[0][1] : -1;
check(paused >= 1200 && unpaused >= 0 && unpaused < 1200, `a 1200 ms pause put ${Math.round(paused)} ms between two keys (${Math.round(unpaused)} ms without it)`);

// Every press is checked before any key goes out.
await clearNotes();
r = await call('type', { keys: ['abc', { press: 'Ctrl+Foo' }] });
let sent = await js(`[document.getElementById('ta').value, window.__keys.length]`);
check(r.isError && /not a key/.test(r.text) && sent[0] === '' && sent[1] === 0, `a bad press in a burst was refused before any key (${JSON.stringify(sent)})`);
r = await call('type', { keys: ['abc', { press: 'Hyper+A' }] });
check(r.isError && /Unknown modifier/.test(r.text), 'an unknown modifier in a burst is refused');
// A key the browser's chord cannot press (not ASCII): refused before "abc".
r = await call('type', { keys: ['abc', { press: 'Ctrl+ö' }] });
sent = await js(`[document.getElementById('ta').value, window.__keys.length]`);
check(r.isError && /step 2 .*must be an ASCII character/.test(r.text) && sent[0] === '' && sent[1] === 0, `a burst with Ctrl+ö was refused before any key (${JSON.stringify(sent)})`);
r = await call('press', { keys: 'Ctrl+ö' });
sent = await js(`[document.getElementById('ta').value, window.__keys.length]`);
check(r.isError && /must be an ASCII character/.test(r.text) && sent[0] === '' && sent[1] === 0, `press Ctrl+ö was refused with no key sent (${JSON.stringify(sent)})`);

// A plain Enter press: the answer counts it as a newline.
r = await call('type', { keys: ['one', { press: 'Enter' }, 'two'], quiet: true });
sent = await js(`document.getElementById('ta').value`);
check(!r.isError && /it leaves "one\\ntwo"/.test(r.text) && sent === 'one\ntwo', `{"press": "Enter"} counted as a newline (${JSON.stringify(sent)})`);
await clearNotes();
r = await call('type', { keys: ['ab', { press: 'ArrowLeft' }, 'c'], quiet: true });
sent = await js(`document.getElementById('ta').value`);
check(!r.isError && !/it leaves/.test(r.text) && sent === 'acb', `without text the arrow is played, and the answer does not claim what it leaves (${JSON.stringify(sent)})`);
r = await call('type', { keys: ['z', { bs: 3 }], quiet: true });
sent = await js(`document.getElementById('ta').value`);
// The caret is between "c" and "b": z, then three Backspaces take z, c and a.
check(/it leaves "" and deletes 2 character\(s\) from before it/.test(r.text) && sent === 'b', `without text a reach-back is played and told (${JSON.stringify(sent)})`);

// press and paste with expect_focus.
await call('click', { id: notes, quiet: true });
await clearNotes();
r = await call('press', { keys: 'Space', expect_focus: notes, quiet: true });
const spaces = (await js(`window.__keys.filter(k => k.key === ' ')`)).length;
check(!r.isError && !/Nothing sent/.test(r.text) && spaces === 1, `press with expect_focus on the focused field went through (${spaces} Space)`);
r = await call('paste', { text: 'pasted', expect_focus: notes, quiet: true });
sent = await js(`document.getElementById('ta').value`);
check(!r.isError && sent === ' pasted', `paste with expect_focus on the focused field went through (${JSON.stringify(sent)})`);
r = await call('press', { keys: 'Space', expect_focus: editor });
check(/does not have the keyboard focus; textarea "Notes" #ta has it/.test(r.text), 'press with expect_focus on another element is refused, naming the textarea');
r = await call('paste', { text: 'no', expect_focus: editor });
check(/^Nothing sent/.test(r.text) && (await js(`document.getElementById('ta').value`)) === ' pasted', 'paste with expect_focus on another element is refused');

// hover at a point.
const hovAt = await js(`(() => { const b = document.getElementById('hov').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
await call('eval_js', { expression: 'window.__hover = 0' });
r = await call('hover', { x: hovAt.x, y: hovAt.y, quiet: true });
check(/^The pointer is at \(/.test(r.text) && (await js('window.__hover')) > 0, `hover at a point reached the box (${r.text.split('\n')[0]})`);

// A drag from a point to an element lets go on it.
await call('eval_js', { expression: 'getSelection().removeAllRanges()' });
await resetMouse();
p = await charAt(0, 0);
r = await call('drag', { from_x: p.x, from_y: p.y, to: dropHere, quiet: true });
const m2 = await js('window.__mouse');
check(!r.isError && new RegExp(`^Dragged from .* to ${dropHere} \\(pointer drag, released\\)`).test(r.text) && m2.down === 1 && m2.up === 1 && m2.upOn[0] === 'drop', `a drag from a point let go on the element (${JSON.stringify(m2.upOn)})`);

// A press on text already selected: the page takes it as a native drag of
// that text, and the answer says so rather than claiming a selection.
await call('eval_js', { expression: 'getSelection().removeAllRanges()' });
let w = await charAt(0, 6);
let w2 = await charAt(0, 11);
await call('drag', { from_x: w.x, from_y: w.y, x: w2.x, y: w2.y, quiet: true });
const picked = (await selection()).text;
await resetMouse();
w = await charAt(0, 8);
w2 = await charAt(0, 25);
r = await call('drag', { from_x: w.x, from_y: w.y, x: w2.x, y: w2.y, quiet: true });
const dnd = await js('window.__dnd');
check(picked === 'bravo' && /^Dragged from .* \(native drag, dropped\)\.\nThe page took the press as a native drag/.test(r.text) && dnd.includes('dragstart') && dnd.includes('drop'), `a press on selected text was answered as a native drag (${JSON.stringify(r.text.split('\n').slice(0, 2))}; the page saw ${JSON.stringify(dnd)})`);

// A drag from a point to an element below the view: the browser turns the
// wheel under the carry and lets go on it.
r = await call('observe', { offscreen: 'full' });
const below = new RegExp('^([a-z]+\\d+) button "Far below"', 'm').exec(r.text)?.[1];
await call('eval_js', { expression: 'getSelection().removeAllRanges()' });
await resetMouse();
p = await charAt(0, 0);
r = await call('drag', { from_x: p.x, from_y: p.y, to: below, quiet: true });
const m3 = await js('window.__mouse');
const scrolled = await js('scrollY');
check(!!below && new RegExp(`^Dragged from .* to ${below} \\(pointer drag, released\\)`).test(r.text) && m3.down === 1 && m3.up === 1 && m3.upOn[0] === 'below' && scrolled > 1000, `a drag from a point to ${below}, below the view, scrolled to it and let go on it (scrollY ${scrolled}, ups on ${JSON.stringify(m3.upOn)})`);
await call('eval_js', { expression: 'scrollTo(0, 0); getSelection().removeAllRanges()' });

// speed: the same text at 2 takes less time than at 0.5 (a fourfold pace,
// well past what a random rhythm spreads).
await call('click', { id: notes, quiet: true });
const span = async (speed) => {
  await clearNotes();
  await call('type', { text: 'paced words here', exact: true, speed, quiet: true });
  const k = await keyTimes();
  return { total: k.at(-1)[1] - k[0][1] };
};
const fast = await span(2);
const slow = await span(0.5);
check(fast.total < slow.total, `speed 2 took ${Math.round(fast.total)} ms, speed 0.5 ${Math.round(slow.total)} ms`);

await call('browser_close');
await client.close();
site.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
