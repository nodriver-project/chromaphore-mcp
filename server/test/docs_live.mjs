// The built server on a real Google Docs document, which draws its text on a
// canvas: a click at a point moves the caret, a scripted burst with a typo
// fixed and an italic word lands at its time and shows in the export, a drag
// between two points selects a word that typing then replaces, expect_focus
// refuses keys while the title box has the focus (it clicks into the title
// and presses Escape there), and the docx export is saved. It types into the
// document it is given, and a failed step can leave stray text in it or in
// its title: use a scratch document, in a
// profile signed in to an account that can edit it. Not run by anything else.
// Usage: node test/docs_live.mjs <profile folder> <fingerprint seed> <document url>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [profile, seed, docUrl] = process.argv.slice(2);
if (!profile || !seed || !docUrl) throw new Error('usage: node test/docs_live.mjs <profile folder> <fingerprint seed> <document url>');
const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, '../../plugin/dist/server.mjs');
const env = { ...process.env };
delete env.CLAUDE_CODE_SESSION_ID;
delete env.CHROMAPHORE_BROWSER;
env.CHROMAPHORE_REPLAY_OPTIONS = 'true';
const client = new Client({ name: 'docs-live', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'inherit' }));

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
async function call(name, args = {}, show = 6) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const lines = text.split('\n');
  console.log(`  ${name} ${JSON.stringify(args).slice(0, 160)} (${Date.now() - t0} ms, ${text.length} chars)${r.isError ? ' ERROR' : ''}\n    ${lines.slice(0, show).join('\n    ')}${lines.length > show ? `\n    … ${lines.length - show} more lines` : ''}`);
  return { text, isError: !!r.isError };
}
const js = async (expression) => (await call('eval_js', { expression }, 0)).text;
const caret = async () => JSON.parse(await js(`JSON.stringify((() => { const c = document.querySelector('#kix-current-user-cursor-caret'); const b = c.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), shown: getComputedStyle(c.closest('.kix-cursor')).display !== 'none' }; })())`));
const docId = /\/d\/([^/]+)/.exec(docUrl)[1];
const exported = async () => {
  const r = await call('fetch', { url: `https://docs.google.com/document/d/${docId}/export?format=txt`, mode: 'raw' }, 0);
  return r.text.split('\n\n').slice(1).join('\n\n').replace(/^﻿/, '');
};

await call('browser_open', { profile, seed: Number(seed), url: docUrl }, 3);
let r = await call('observe', { offscreen: 'full' }, 0);
const docBox = /^(\w+\d+) textbox "Document content"/m.exec(r.text)?.[1];
check(!!docBox, `the listing has the Document content textbox (${docBox})`);

// 1. A click at a point: where the first line starts (the caret after
// Ctrl+Home says where), 40 px in; the caret moves there.
await call('press', { keys: 'Ctrl+Home', quiet: true });
const home = await caret();
r = await call('click', { x: home.x + 40, y: home.y + 8, quiet: true });
let c = await caret();
check(!r.isError && c.shown && c.y === home.y && Math.abs(c.x - (home.x + 40)) < 6, `a click at a point put the caret there (${JSON.stringify(home)} -> ${JSON.stringify(c)})`);
check(r.text.length < 600, `quiet keeps the answer short (${r.text.length} chars)`);
r = await call('press', { keys: 'Ctrl+End', quiet: true });

// 2. A burst with a typo fixed on the spot, an italic word, a pause, at a set time.
const when = Date.now() + 6000;
const keys = ['\nBurst: Hello wrold', { bs: 4 }, 'orld and ', { press: 'Ctrl+I' }, 'italics', { press: 'Ctrl+I' }, { pause_ms: 700 }, '.'];
r = await call('type', { keys, text: '\nBurst: Hello world and italics.', not_before: new Date(when).toISOString(), expect_focus: docBox, quiet: true, seed: 42 });
const ran = /Ran from ([^\s,]+)/.exec(r.text)?.[1];
check(!r.isError && ran && Date.parse(ran) >= when && Date.parse(ran) - when < 1500, `the burst began at not_before (${ran} vs ${new Date(when).toISOString()})`);
// A burst whose keys do not leave its text is refused before any key.
r = await call('type', { keys: ['abc', { bs: 1 }], text: 'abc' });
check(/Nothing typed: keys leave "ab"/.test(r.text), 'a burst that does not leave its text is refused');
await new Promise((res) => setTimeout(res, 2500));
let text = await exported();
check(/Burst: Hello world and italics\.\s*$/.test(text), `the export ends with the burst: ${JSON.stringify(text.slice(-60))}`);

// 3. Select a word by dragging between two points on the last line, type over it.
// The last line's left edge is the page's text start; "Burst: " is about 46 px
// at 11 pt Arial, so the drag runs from x+0 to x+40 to take "Burst:".
await call('press', { keys: 'Home', quiet: true });
c = await caret();
r = await call('drag', { from_x: c.x, from_y: c.y + 8, x: c.x + 40, y: c.y + 8, quiet: true });
check(!r.isError && /Dragged from/.test(r.text), 'dragged between two points');
r = await call('type', { text: 'Burst2:', exact: true, expect_focus: docBox, quiet: true });
await new Promise((res) => setTimeout(res, 2500));
text = await exported();
check(/\nBurst2: Hello world and italics\.\s*$/.test(text), `typing replaced the dragged selection: ${JSON.stringify(text.slice(-50))}`);

// 4. expect_focus: with the focus moved to the title box, nothing is sent.
r = await call('observe', { offscreen: 'none' }, 0);
const title = /^(\w+\d+) textbox "Rename"/m.exec(r.text)?.[1];
if (!title) throw new Error('the title box ("Rename") is not listed; stopping before any key');
await call('click', { id: title, quiet: true });
r = await call('type', { text: 'must not land', exact: true, expect_focus: docBox });
check(/^Nothing sent: .* does not have the keyboard focus/.test(r.text), 'expect_focus refused keys while the title box had the focus');
r = await call('press', { keys: 'Escape', expect_focus: title, quiet: true });
check(!/Nothing sent/.test(r.text), 'expect_focus let a key through to the element that had the focus');

// 5. A docx export saved where asked.
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'docs-live-')), 'export-test.docx');
r = await call('fetch', { url: `https://docs.google.com/document/d/${docId}/export?format=docx`, save_to: out }, 3);
check(/Body saved to .*export-test\.docx/.test(r.text), 'the docx export was saved where asked');

await call('browser_close', {}, 1);
await client.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
