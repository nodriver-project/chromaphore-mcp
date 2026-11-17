// Input through the commands of a browser newer than release 2.0.0, on local
// pages: the clipboard (read after a page's own copy, set, then pasted);
// a burst as one command (its keys in order, its pause, the answer's one
// schedule); a burst and a string stopped when the page moves the focus to
// another field midway (the answer says, from the browser's timeline, how
// many characters had their key go down and which are uncertain, the field
// holds between those less the uncertain ones and all of them, and nothing
// goes out after); a cancel mid-string that stops it at once with no key left down;
// a drag between two points inside a frame of another site, carried out.
// On a browser that predates them: the clipboard is refused in one sentence,
// the drag in such a frame keeps its older answer and hint, and the rest is
// one SKIP line.
// Usage: node test/browser_input.mjs [server.mjs]
// (CHROMAPHORE_TEST_BROWSER names the chrome.exe; else the installed release.)
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = process.argv[2] ?? path.resolve(here, '../../plugin/dist/server.mjs');

// The frame of another site (localhost against 127.0.0.1): an editable that
// tells its parent where its characters are and what it selected.
const far = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:20px/30px Arial}</style>
<div id="ed" contenteditable="true">Alpha bravo charlie delta</div>
<script>
const t = document.getElementById('ed').firstChild;
const at = (i) => { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i); const b = r.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2 }; };
const tell = () => parent.postMessage({ chars: [...Array(t.length + 1).keys()].map(at), sel: getSelection().toString() }, '*');
document.addEventListener('selectionchange', tell);
addEventListener('load', tell);
tell();
</script>`;
const other = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(far);
});
await new Promise((r) => other.listen(0, '127.0.0.1', r));
const farUrl = `http://localhost:${other.address().port}/`;

const page = `<!doctype html><meta charset="utf-8"><title>input</title>
<style>body{font:16px Arial;margin:20px} iframe{width:420px;height:50px;border:0;display:block}</style>
<div id="src"><div>First line</div><div>Second line</div></div>
<button id="copy" onclick="const r = document.createRange(); r.selectNodeContents(document.getElementById('src')); getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand('copy'); getSelection().removeAllRanges();">Copy</button>
<textarea id="a" aria-label="First field" rows="2"></textarea>
<input id="b" aria-label="Second field">
<iframe id="far" title="Far editor" src="${farUrl}"></iframe>
<script>
window.__log = [];
for (const t of ['keydown', 'keyup']) document.addEventListener(t, (e) => { if (!e.repeat) window.__log.push({ t: t === 'keydown' ? 'd' : 'u', code: e.code, key: e.key, at: e.timeStamp, on: e.target.id }); }, true);
window.__far = { chars: [], sel: '' };
addEventListener('message', (e) => { if (e.data && e.data.chars) window.__far = e.data; });
// Once so many characters have landed in the first field, the page moves the
// focus. Counted in characters, not in time after the first key: the typist
// can pause before a letter for longer than any fixed wait.
window.armMove = (chars) => {
  let left = chars;
  document.getElementById('a').addEventListener('input', () => { if (left > 0 && --left === 0) document.getElementById('b').focus(); });
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
const client = new Client({ name: 'input-test', version: '0' });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let r = await call('browser_open', { profile: 'temp', headless: true, url: base });
await sleep(1000);
r = await call('observe');
const idOf = (re) => new RegExp(`^([a-z]+\\d+) ${re}`, 'm').exec(r.text)?.[1];
const ids = { copy: idOf('button "Copy"'), a: idOf('textbox "First field"'), b: idOf('textbox "Second field"') };
check(Object.values(ids).every(Boolean), `the controls are listed (${JSON.stringify(ids)})`);
r = await call('clipboard');
const firstRead = r.text;
const modern = !/predates/.test(r.text);
console.log(`  browser: ${modern ? 'newer than release 2.0.0' : 'release 2.0.0 or older'}`);

// A drag between two points inside a frame of another site.
const farPoints = async (i, j) => {
  const v = await js(`(() => { const f = document.getElementById('far').getBoundingClientRect(); const c = window.__far.chars; return [{ x: f.left + c[${i}].x, y: f.top + c[${i}].y }, { x: f.left + c[${j}].x, y: f.top + c[${j}].y }]; })()`);
  return v;
};
const [fa, fb] = await farPoints(6, 19);
r = await call('drag', { from_x: fa.x, from_y: fa.y, x: fb.x, y: fb.y, quiet: true });
await sleep(300);
const farSel = await js('window.__far.sel');
console.log(`  drag inside a frame of another site: "${r.text.split('\n')[0]}"; the frame selected ${JSON.stringify(farSel)}`);

if (!modern) {
  check(r.isError === false && /^Not dragged: covered, .*another frame is on top of where.* The start point is inside a frame of another site or process/.test(r.text), 'the drag inside a frame of another site keeps the older answer and its hint');
  r = await call('clipboard', { set: 'x' });
  check(r.isError && /^This browser predates reading or setting its own clipboard: it needs a Chromaphore build newer than release 2\.0\.0\. Nothing was done\.$/.test(r.text), `the clipboard is refused in one sentence (${r.text})`);
  console.log('SKIP the clipboard, the burst as one command, the stop on a focus change and the cancel mid-string: this browser predates Input.readClipboard and dispatchKeystrokes steps (a Chromaphore build newer than release 2.0.0 has them)');
} else {
  check(/^Dragged from .* \(pointer drag, released\)\./.test(r.text) && farSel === 'bravo charlie', `a drag inside a frame of another site is carried out there and selects what lies between (${JSON.stringify(farSel)})`);

  // The clipboard after the page's own copy: text with its line break shown
  // as \n (the browser stores CRLF), and HTML.
  check(/^The clipboard holds no text\.\nIt holds no HTML\.$/.test(firstRead), `a new browser's clipboard is empty (${JSON.stringify(firstRead)})`);
  await call('click', { id: ids.copy, quiet: true });
  r = await call('clipboard');
  check(/^The clipboard holds 22 character\(s\) of text, line breaks as \\n:\n"First line\\nSecond line"\nIt also holds HTML \(\d+ characters\); html: true shows it\.$/.test(r.text), `a page's copy reads with its line break as \\n, its length and its HTML (${JSON.stringify(r.text)})`);
  r = await call('clipboard', { html: true });
  check(/It also holds HTML \(\d+ characters\):\n.*First line.*Second line/s.test(r.text) && /<div/.test(r.text), 'html: true shows the HTML');
  // set, then a paste of it.
  r = await call('clipboard', { set: 'Set one\nSet two' });
  check(/^Put 15 character\(s\) on the browser's clipboard \(nothing was pasted\)\.\nThe clipboard holds 15 character\(s\) of text, line breaks as \\n:\n"Set one\\nSet two"\nIt holds no HTML\.$/.test(r.text), `set puts the text there and reads it back (${JSON.stringify(r.text)})`);
  await call('click', { id: ids.a, quiet: true });
  await call('eval_js', { expression: "document.getElementById('a').value = ''" });
  r = await call('press', { keys: 'Ctrl+V', quiet: true });
  const pasted = await js(`document.getElementById('a').value`);
  check(pasted === 'Set one\nSet two', `Ctrl+V pastes what was set (${JSON.stringify(pasted)})`);

  // A burst as one command: its keys in order and its pause, as the page saw them.
  const clear = () => call('eval_js', { expression: "document.getElementById('a').value = ''; document.getElementById('b').value = ''; window.__log.length = 0; document.getElementById('a').focus()" });
  await clear();
  r = await call('type', { keys: ['Hello', { pause_ms: 900 }, ' wor', { bs: 2 }, 'orld', { press: 'Enter' }, 'x'], expect_focus: ids.a, quiet: true });
  const value = await js(`document.getElementById('a').value`);
  const downs = await js(`window.__log.filter((k) => k.t === 'd' && k.key !== 'Shift')`);
  const order = downs.map((k) => k.key).join('|');
  const iO = downs.findIndex((k) => k.key === 'o');
  const gap = iO >= 0 ? downs[iO + 1].at - downs[iO].at : -1;
  console.log(`  keys ${order}; pause ${Math.round(gap)} ms`);
  check(/^Typed the burst \(one schedule, \d+\.\d s\): 14 character\(s\), 2 Backspace\(s\), 1 key press\(es\), 1 pause\(s\); it leaves "Hello world\\nx"\./.test(r.text), `the burst went as one schedule, and the answer says what it leaves (${r.text.split('\n')[0]})`);
  check(value === 'Hello world\nx' && order === 'H|e|l|l|o| |w|o|r|Backspace|Backspace|o|r|l|d|Enter|x', `the page saw its keys in order and the text it leaves (${JSON.stringify(value)})`);
  check(gap >= 900, `the pause stood between "Hello" and " wor" (${Math.round(gap)} ms)`);

  // The page moves the focus to the second field once six characters have
  // landed: the burst stops, says what went out, and nothing goes out after.
  for (const [what, args] of [
    ['a burst', { keys: ['A burst that goes on for a good while yet', { press: 'Enter' }, 'more'] }],
    ['a string', { text: 'A string that goes on for a good while yet', exact: true }],
  ]) {
    await clear();
    await call('eval_js', { expression: 'armMove(6)' });
    r = await call('type', { ...args, expect_focus: ids.a, submit: true });
    const at = await js(`[document.getElementById('a').value, document.getElementById('b').value]`);
    await sleep(1500);
    const later = await js(`[document.getElementById('a').value, document.getElementById('b').value, window.__log.filter((k) => k.key === 'Enter').length]`);
    // The account, counted from the browser's timeline: the characters whose
    // key went down reached a field; those listed uncertain may have gone to
    // the one that took the focus.
    const full = args.text ?? args.keys[0];
    const down = new RegExp(`(\\d+) of ${full.length} character\\(s\\) had their key go down \\(they reached a field\\)`).exec(r.text);
    const n = down ? Number(down[1]) : -1;
    const unsure = /Of them, the browser lists (\d+) as uncertain \(.*\): they may have gone to the field that took the focus, so \S+ holds between (\d+) and (\d+) of them\./.exec(r.text);
    const u = unsure ? Number(unsure[1]) : 0;
    const accounted = unsure ? Number(unsure[2]) === n - u && Number(unsure[3]) === n : n > 0 && r.text.includes(`The browser lists none of them as uncertain: all ${n} went to ${ids.a}.`);
    console.log(`  ${what}: ${r.text.split('\n').slice(0, 3).join(' | ')}; fields ${JSON.stringify(at)}`);
    const told = what === 'a burst'
      ? new RegExp(`^The burst stopped: the focus left ${ids.a}\\. 0 of 3 step\\(s\\) went out whole; of step 1 \\("[^"]*"\\), \\d+ of ${full.length} character\\(s\\) had their key go down \\(they reached a field\\); nothing after\\.`)
      : new RegExp(`^Typing stopped: the focus left ${ids.a} after \\d+ of ${full.length} character\\(s\\) had their key go down \\(they reached a field\\); nothing after\\.`);
    check(told.test(r.text) && accounted, `${what} stopped when the focus left, and said how many characters went down and which are uncertain`);
    check(full.startsWith(at[0]) && at[0].length >= n - u && at[0].length <= n && at[0].length < full.length, `${what}: the first field holds between the characters that went down less the uncertain ones and all that went down (${JSON.stringify(at[0])}, ${n} down, ${u} uncertain)`);
    check(JSON.stringify(later.slice(0, 2)) === JSON.stringify(at) && later[2] === 0, `${what}: nothing went out after the stop, no Enter (${JSON.stringify(later)})`);
  }

  // A press that makes the page move the focus: the burst stops in that step,
  // and the answer says the press itself went out.
  await clear();
  await call('eval_js', { expression: "document.getElementById('a').addEventListener('keydown', (e) => { if (e.key === 'F8') document.getElementById('b').focus(); })" });
  r = await call('type', { keys: ['ab', { press: 'F8' }, 'cd'], expect_focus: ids.a });
  await sleep(800);
  const pressed = await js(`[document.getElementById('a').value, document.getElementById('b').value]`);
  console.log(`  a press: ${r.text.split('\n').slice(0, 2).join(' | ')}; fields ${JSON.stringify(pressed)}`);
  check(/^The burst stopped: the focus left \S+\. 1 of 3 step\(s\) went out whole; of step 2 \(\{"press": "F8"\}\), its key went down: the press was made, so do not press it again; nothing after\./.test(r.text), 'a stop inside a press step says the press went out');
  check(pressed[0] === 'ab' && pressed[1] === '', `nothing of the step after it was typed (${JSON.stringify(pressed)})`);

  // A cancel mid-string stops it at once; every key that went down came up.
  await clear();
  const text = 'Words Typed With Shift Here And There Until It Is Cut';
  const ac = new AbortController();
  const answered = call('type', { text, exact: true }, ac.signal).then(() => 'answered', (e) => `rejected: ${e.message}`);
  await sleep(1500);
  ac.abort();
  const how = await answered;
  await sleep(1500);
  const cut = await js(`[document.getElementById('a').value, window.__log]`);
  await sleep(1000);
  const after = await js(`document.getElementById('a').value`);
  const held = {};
  for (const k of cut[1]) held[k.code] = (held[k.code] ?? 0) + (k.t === 'd' ? 1 : -1);
  const down = Object.entries(held).filter(([, v]) => v !== 0);
  console.log(`  cancelled after ${cut[0].length} of ${text.length} characters; the call ${how}; keys left down ${JSON.stringify(down)}`);
  check(text.startsWith(cut[0]) && cut[0].length > 0 && cut[0].length < text.length - 10 && after === cut[0], `a cancel stopped the string under way (${JSON.stringify(cut[0])})`);
  check(down.length === 0, `no key was left down (by code: ${JSON.stringify(down)})`);
  r = await call('observe');
  check(!r.isError, 'the server answers after the cancel');
}

await call('browser_close');
await client.close();
site.close();
other.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
