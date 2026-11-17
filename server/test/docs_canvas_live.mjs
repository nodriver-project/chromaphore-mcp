// The built server on a real Google Docs document, with a browser that reads
// canvas text (newer than release 2.0.0): the listing ends with the document's
// text and a Docs line; a click aimed by the text around it puts the caret
// there, and the Docs line reads it; a typed marker shows in the changed line;
// a word selected by its text is read as the selection and lands on the
// clipboard; a dry run plans a burst and types nothing; the burst plays as one
// command at its time, with a key log; text set on the clipboard pastes; and
// with the title box focused, keys for the document are refused and the Docs
// line says the document lacks the keyboard. It types into the document it is
// given and clicks into its title: use a scratch document, in a profile signed
// in to an account that can edit it. Run by hand; an older browser gets one
// SKIP line.
// Usage: node test/docs_canvas_live.mjs <profile folder> <fingerprint seed> <document url> [chrome.exe]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [profile, seed, docUrl, exe] = process.argv.slice(2);
if (!profile || !seed || !docUrl) throw new Error('usage: node test/docs_canvas_live.mjs <profile folder> <fingerprint seed> <document url> [chrome.exe]');
const here = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, CHROMAPHORE_REPLAY_OPTIONS: 'true' };
delete env.CLAUDE_CODE_SESSION_ID;
delete env.CHROMAPHORE_BROWSER;
if (exe) env.CHROMAPHORE_BROWSER = exe;
const client = new Client({ name: 'docs-canvas-live', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve(here, '../../plugin/dist/server.mjs')], env, stderr: 'inherit' }));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };
async function call(name, args = {}, show = 8) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const lines = text.split('\n');
  console.log(`  ${name} ${JSON.stringify(args).slice(0, 170)} (${Date.now() - t0} ms, ${text.length} chars)${r.isError ? ' ERROR' : ''}\n    ${lines.slice(-show).join('\n    ')}`);
  return { text, isError: !!r.isError };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (text) => text.split('Canvas text in view:')[1] ?? '';

let r = await call('browser_open', { profile, seed: Number(seed), url: docUrl }, 10);
if (/predates/.test((await call('clipboard', {}, 1)).text)) {
  console.log('SKIP the canvas text, the Docs lines, the clipboard and the burst as one command: this browser predates them (a Chromaphore build newer than release 2.0.0 has them)');
  await call('browser_close', {}, 1);
  await client.close();
  process.exit(0);
}
check(/Canvas text in view:/.test(r.text) && /Chromaphore test\./.test(section(r.text)), 'the page listing ends with the document text read off the canvas');
check(/^Docs (caret|selection|: no caret)/m.test(r.text) || /^Docs: no caret/m.test(r.text), 'the listing has a Docs line');
r = await call('observe', { offscreen: 'full' }, 0);
const docBox = /^(\w+\d+) textbox "Document content"/m.exec(r.text)?.[1];

// A click placed by the text around it: the Docs line says where the caret is.
r = await call('click', { text_before: 'Chromaphore ', text_after: 'test.', quiet: true });
check(!r.isError && /Clicked between/.test(r.text), 'a click aimed by text_before and text_after');
check(/Docs caret: after "Chromaphore " and before "test\./.test(r.text), 'the Docs line reads the caret where the click was aimed');
r = await call('type', { text: 'Q', exact: true, expect_focus: docBox, quiet: true });
check(/Canvas text changed:/.test(r.text) && /\+ .*Chromaphore Qtest\./.test(r.text), 'the answer shows the changed line, with the marker exactly at the aimed place');
check(/Docs caret: after "Chromaphore Q" and before "test\./.test(r.text), 'the caret is read after the typed marker');
r = await call('press', { keys: 'Backspace', expect_focus: docBox, quiet: true });
check(/\+ .*Chromaphore test\./.test(r.text), 'Backspace took the marker out, and the answer shows the line as it was');

// Select a word by its text: the Docs line reads it; the clipboard confirms.
r = await call('drag', { select: 'Chromaphore', text_after: ' test.', quiet: true });
check(!r.isError && /pointer drag, released/.test(r.text), 'a drag aimed by the text to select');
check(/Docs selection: "Chromaphore" \(11 characters as drawn, on 1 line\(s\)\)\./.test(r.text), 'the Docs line reads the selection as text');
await call('press', { keys: 'Ctrl+C', quiet: true }, 2);
r = await call('clipboard', {}, 4);
check(/Chromaphore/.test(r.text) && !/Chromaphore test/.test(r.text), 'the clipboard holds exactly the selected word');

// The end of the document, then a dry run: nothing is typed.
r = await call('press', { keys: 'Ctrl+End', quiet: true }, 3);
check(/Docs caret: .*\(at the end of a line\)\./.test(r.text), 'the caret at the end of the document is read as at the end of a line');
const keys = ['\nLive: abd', { bs: 1 }, 'c', { press: 'Ctrl+I' }, ' it', { press: 'Ctrl+I' }, { pause_ms: 300 }, '!'];
r = await call('type', { keys, text: '\nLive: abc it!', dry_run: true }, 4);
const dry = /(\d[\d,.]*) ?(ms|s)\b/.exec(r.text);
const seedUsed = /seed (\d+)/i.exec(r.text)?.[1];
check(!r.isError && !!dry && !!seedUsed && !/Canvas text changed/.test(r.text), `a dry run answered a duration and a seed, and typed nothing (${dry?.[0]}, seed ${seedUsed})`);

// The burst itself, with that seed, a start time, the focus watched and a key log.
const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'docs-live-')), 'keys.jsonl');
const when = Date.now() + 5000;
r = await call('type', { keys, text: '\nLive: abc it!', seed: Number(seedUsed), not_before: new Date(when).toISOString(), expect_focus: docBox, key_log: log, quiet: true }, 10);
check(!r.isError && /one schedule/.test(r.text) && /\+ .*Live: abc it!/.test(r.text), 'a burst played as one command, and its line read back off the canvas');
check(/Docs caret: after ".*Live: abc it!" and before ""/.test(r.text), 'the caret is read after the burst');
const logged = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
const first = logged[0]?.events?.[0];
check(logged.length === 1 && logged[0].events.length > 10 && logged[0].startEpochMs + first.timeMs >= when, `the key log holds the burst's events, the first at or after not_before (${logged[0]?.events?.length} events, first ${logged[0] ? Math.round(logged[0].startEpochMs + first.timeMs - when) : '?'} ms after)`);

// The clipboard set, then pasted.
await call('clipboard', { set: ' Pasted from the clipboard.' }, 3);
r = await call('press', { keys: 'Ctrl+V', expect_focus: docBox, quiet: true }, 6);
check(/\+ .*Live: abc it! Pasted from the clipboard\./.test(r.text), 'text set on the clipboard pasted with Ctrl+V');

// The title box takes the focus: keys for the document are refused, and the Docs line says no caret shows.
r = await call('observe', { offscreen: 'none' }, 0);
const title = /^(\w+\d+) textbox "Rename"/m.exec(r.text)?.[1];
if (title) {
  r = await call('click', { id: title, quiet: true }, 3);
  check(/^Docs caret: .* The document does not have the keyboard focus: keys would not go there\.$/m.test(r.text), 'with the title box focused the Docs line says the document lacks the keyboard');
  r = await call('type', { text: 'must not land', exact: true, expect_focus: docBox }, 3);
  check(/Nothing sent: .* does not have the keyboard focus/.test(r.text) && /Rename/.test(r.text), 'expect_focus refused keys while the title box had the focus, and named it');
  await call('press', { keys: 'Escape', quiet: true }, 2);
}
await sleep(1500);
await call('browser_close', {}, 1);
await client.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
