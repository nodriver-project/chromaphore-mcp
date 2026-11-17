// The replay options setting (docs/DESIGN.md, "General and replay options").
// Off (unset, empty, "false", or the unsubstituted ${user_config...} text):
// type, press and paste list no not_before and type no seed, nothing the
// agent reads (instructions, schemas, no file under plugin/skills) mentions
// them or the burst text check, fetch keeps its
// readOnlyHint; on a page, type with text and keys is refused, and a call
// passing not_before or seed anyway is refused, with no key reaching the page
// before or after its time. On ("true"): the schemas list them, the
// instructions say how to use each of the three, and the
// options work: not_before holds the first key (type, press, paste), a
// time without a zone or past 15 minutes is refused, the expect_focus id is
// resolved again after the wait, a cancel during the wait sends nothing, the
// burst text check refuses before any key, and one seed gives one rhythm.
// On a newer browser, with the setting on: dry_run plans and sends nothing,
// and a burst typed with its seed plays the plan; key_log appends a line per
// call (its folder made; a failure to write told, the rest kept); the time
// line comes from the timeline; the seed used is said; dry_run with id,
// clear, submit, not_before or expect_focus is refused by name. On an older
// browser dry_run and key_log are refused in one sentence, then one SKIP.
// dry_run and key_log are refused by name with the setting off.
// Usage: node test/replay_options.mjs [server.mjs]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = process.argv[2] ?? path.resolve(here, '../../plugin/dist/server.mjs');

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

// A server with the setting given as value (undefined: the variable unset).
async function start(value) {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CHROMAPHORE_BROWSER;
  if (process.env.CHROMAPHORE_TEST_BROWSER) env.CHROMAPHORE_BROWSER = process.env.CHROMAPHORE_TEST_BROWSER;
  delete env.CHROMAPHORE_REPLAY_OPTIONS;
  if (value !== undefined) env.CHROMAPHORE_REPLAY_OPTIONS = value;
  const client = new Client({ name: 'replay-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'inherit' }));
  return client;
}
const label = (value) => (value === undefined ? 'unset' : JSON.stringify(value));

// 1. What the agent is shown, for each way of being off and for on.
const OFF = [undefined, '', 'false', '${user_config.replay_options}'];
for (const value of [...OFF, 'true']) {
  const on = value === 'true';
  console.log(`replay_options: ${on ? 'on' : 'off'} (CHROMAPHORE_REPLAY_OPTIONS ${label(value)})`);
  const client = await start(value);
  const { tools } = await client.listTools();
  const tool = (n) => tools.find((t) => t.name === n);
  const props = (n) => Object.keys(tool(n)?.inputSchema?.properties ?? {});
  const instructions = client.getInstructions() ?? '';
  // The general options are listed either way, so an empty list cannot pass.
  check(
    ['keys', 'speed', 'expect_focus', 'quiet'].every((k) => props('type').includes(k)) &&
      ['expect_focus', 'quiet'].every((k) => props('press').includes(k) && props('paste').includes(k)) &&
      /expect_focus/.test(instructions),
    `[${label(value)}] type, press and paste list their general options, and the instructions name expect_focus`,
  );
  const listed = ['type', 'press', 'paste'].map((n) => `${n}: ${props(n).filter((k) => k === 'not_before' || k === 'seed').join(',') || '-'}`).join('; ');
  const words = (n) => JSON.stringify({ d: tool(n)?.description, s: tool(n)?.inputSchema });
  const textDesc = tool('type')?.inputSchema?.properties?.text?.description ?? '';
  if (on) {
    check(props('type').includes('not_before') && props('type').includes('seed') && props('press').includes('not_before') && props('paste').includes('not_before'), `[on] the schemas list not_before and type's seed (${listed})`);
    check(props('type').includes('dry_run') && props('type').includes('key_log'), `[on] type's schema lists dry_run and key_log (${props('type').join(',')})`);
    check(/not_before/.test(instructions) && /must leave/.test(textDesc), '[on] the instructions name not_before and type\'s text describes the check');
    // The guidance that was the replay skill, one clause per point it must make.
    const guide = {
      'not_before: at most 15 minutes ahead': /not_before[^.]*at most 15 minutes ahead/,
      'not_before: place the caret first, only the keys wait': /place the caret first[^.]*only the keys wait/,
      'not_before: refused before the wait': /refused before the wait/,
      'not_before: the focus checked after the wait': /focus itself is checked after the wait/,
      'not_before: a cancel during the wait sends nothing': /cancelling during the wait sends nothing/,
      'seed: repeats the rhythm of the typed strings': /seed on type[^.]*repeat the rhythm of the typed strings/,
      'seed: not the timing of presses and Backspaces': /not the timing of key presses and Backspaces/,
      'text check: keys and text checked before any key': /both keys and text checks, before any key, that the burst leaves exactly text/,
      'text check: what Enter, Tab, Space and Backspace count as': /Enter, Tab or Space press counts as its character and a plain Backspace as one bs/,
      'text check: what it refuses': /presses the check cannot follow[^.]*Backspaces reaching before its start is refused/,
      'text check: leave text out to play unchecked': /leave text out to play it unchecked/,
      'dry_run: plans and sends nothing': /dry_run, which plans the text or burst and sends nothing/,
      'dry_run: what it cannot go with': /not with id, clear, submit, not_before or expect_focus/,
      'dry_run: the seed that gives that schedule': /seed that gives that schedule/,
      'key_log: one JSON line per call': /key_log, a file each call appends one JSON line of its key events to/,
      'the times from the first key down to the last key up': /with not_before or key_log the answer times the first key down and the last key up/,
      'the seed used': /says the seed used/,
    };
    const missing = Object.entries(guide).filter(([, re]) => !re.test(instructions)).map(([k]) => k);
    check(missing.length === 0, `[on] the instructions carry the guidance for all three options${missing.length ? ` (missing: ${missing.join('; ')})` : ''}`);
  } else {
    check(['type', 'press', 'paste'].every((n) => !props(n).includes('not_before')) && !['seed', 'dry_run', 'key_log'].some((k) => props('type').includes(k)), `[${label(value)}] no schema lists not_before, seed, dry_run or key_log (${listed}; type: ${props('type').join(',')})`);
    check(['type', 'press', 'paste'].every((n) => !/not_before|dry_run|key_log/.test(words(n))) && !/seed/.test(words('type')), `[${label(value)}] no description of type, press or paste mentions not_before, seed, dry_run or key_log`);
    check(!/must leave|checked before/.test(textDesc) && /not both/.test(textDesc), `[${label(value)}] type's text does not describe the check (${JSON.stringify(textDesc)})`);
    check(!/not_before|must leave|text check|replay/i.test(instructions) && !/\bseed\b/.test(instructions), `[${label(value)}] the instructions mention none of the three`);
  }
  check(tool('fetch')?.annotations?.readOnlyHint === true, `[${label(value)}] fetch keeps its readOnlyHint (${JSON.stringify(tool('fetch')?.annotations ?? null)})`);
  await client.close();
}

// 1b. The skills. A skill's name and description are listed to every agent,
// setting or not, so no file under plugin/skills may name the replay options
// (their guidance is in the instructions, sent only with the setting on).
{
  const skillsDir = path.resolve(here, '../../plugin/skills');
  const files = fs.readdirSync(skillsDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
  const naming = /not_before|replay|must leave|text check|typing seed|seed\W+on\W+type/i;
  const hits = files.flatMap((f) =>
    fs.readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
      // A line that names a seed must be about the fingerprint seed of
      // browser_open, the only seed there is with the setting off.
      naming.test(line) || (/\bseed\b/i.test(line) && !/fingerprint|browser_open/i.test(line))
        ? [`${path.relative(skillsDir, f)}:${i + 1}: ${line.trim().slice(0, 100)}`]
        : [],
    ),
  );
  check(
    files.some((f) => path.relative(skillsDir, f) === path.join('browser', 'SKILL.md')) && hits.length === 0,
    `[off] no file under plugin/skills mentions not_before or the replay options (${files.length} files read${hits.length ? `; ${hits.join(' | ')}` : ''})`,
  );
}

// 2. On a page.
const page = `<!doctype html><meta charset="utf-8"><title>replay</title>
<style>body{font:20px/30px Arial;margin:40px} #ed{width:700px;border:1px solid #888;padding:10px}</style>
<div id="ed" contenteditable="true" role="textbox" aria-label="Editor"><p>Hotel india juliet kilo lima.</p></div>
<textarea id="ta" aria-label="Notes" rows="2"></textarea>
<input id="vanish" aria-label="Vanish field">
<script>
window.__keys = [];
window.__pasted = 0;
window.__mouse = { move: 0, down: 0 };
document.addEventListener('keydown', (e) => window.__keys.push({ key: e.key, t: Date.now(), ts: e.timeStamp }), true);
document.addEventListener('paste', () => window.__pasted++, true);
document.addEventListener('mousemove', () => window.__mouse.move++, true);
document.addEventListener('mousedown', () => window.__mouse.down++, true);
</script>`;
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

function driver(client) {
  async function call(name, args = {}, signal) {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000, ...(signal ? { signal } : {}) });
    const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    console.log(`  ${name} ${JSON.stringify(args).slice(0, 140)}: ${r.isError ? 'ERROR ' : ''}${text.split('\n')[0]}`);
    return { text, isError: !!r.isError };
  }
  const js = async (expression) => JSON.parse((await call('eval_js', { expression: `JSON.stringify(${expression})` })).text);
  return { call, js };
}
const idIn = (listing, re) => new RegExp(`^([a-z]+\\d+) ${re}`, 'm').exec(listing)?.[1];
const reset = "document.getElementById('ta').value = ''; window.__keys.length = 0; window.__pasted = 0; window.__mouse.move = 0; window.__mouse.down = 0";
const state = (d) => d.js(`[document.getElementById('ta').value, window.__keys.length, window.__pasted, window.__mouse.down]`);
const nothing = (s) => s[0] === '' && s[1] === 0 && s[2] === 0;

// 2a. Off: the options are refused, and no key goes out.
{
  console.log('replay_options: off (CHROMAPHORE_REPLAY_OPTIONS unset), on a page');
  const client = await start(undefined);
  const d = driver(client);
  let r = await d.call('browser_open', { profile: 'temp', headless: true, url: base });
  const notes = idIn(r.text, 'textbox "Notes"');
  check(!!notes, `the page is listed (${notes})`);
  await d.call('click', { id: notes, quiet: true });

  await d.call('eval_js', { expression: reset });
  r = await d.call('type', { id: notes, keys: ['abc'], text: 'abc' });
  let s = await state(d);
  check(r.isError && /give text or keys, not both/.test(r.text) && /Replay options/.test(r.text) && nothing(s) && s[3] === 0, `[off] type with text and keys is refused, naming the setting, with no key or click sent (${JSON.stringify(s)}; ${r.text})`);

  // A not_before a little ahead: refused at once, and nothing goes out at
  // the time either, as it would if the server had dropped the key and typed.
  for (const [tool, args] of [
    ['type', { text: 'early', exact: true }],
    ['press', { keys: 'x' }],
    ['paste', { text: 'pasted' }],
  ]) {
    await d.call('eval_js', { expression: reset });
    const until = Date.now() + 2000;
    const t0 = Date.now();
    r = await d.call(tool, { ...args, not_before: new Date(until).toISOString() });
    const took = Date.now() - t0;
    const before = await state(d);
    await new Promise((res) => setTimeout(res, until - Date.now() + 1500));
    const after = await state(d);
    check(
      r.isError && /not_before is available only with the plugin's "Replay options" setting/.test(r.text) && took < 1500 && nothing(before) && nothing(after),
      `[off] ${tool} with not_before is refused at once (${took} ms), naming the setting; nothing reached the page before the time (${JSON.stringify(before)}) or after it (${JSON.stringify(after)})`,
    );
  }
  await d.call('eval_js', { expression: reset });
  r = await d.call('type', { text: 'seeded', exact: true, seed: 7 });
  s = await state(d);
  check(r.isError && /seed is available only with/.test(r.text) && nothing(s), `[off] type with seed is refused, naming the setting; no key sent (${JSON.stringify(s)})`);
  r = await d.call('type', { text: 'both', not_before: Date.now() + 2000, seed: 7 });
  check(r.isError && /not_before and seed are available only/.test(r.text), '[off] both at once are named');
  for (const extra of [{ dry_run: true }, { key_log: 'keys.jsonl' }]) {
    await d.call('eval_js', { expression: reset });
    r = await d.call('type', { text: 'planned', exact: true, ...extra });
    s = await state(d);
    const name = Object.keys(extra)[0];
    check(r.isError && new RegExp(`^Nothing was sent: ${name} is available only with the plugin's "Replay options" setting`).test(r.text) && nothing(s), `[off] type with ${name} is refused, naming the setting; no key sent (${JSON.stringify(s)})`);
  }
  // The general features still type.
  await d.call('eval_js', { expression: reset });
  r = await d.call('type', { keys: ['ab', { bs: 1 }, 'c'], quiet: true });
  s = await state(d);
  check(!r.isError && s[0] === 'ac' && /it leaves "ac"/.test(r.text), `[off] a burst without text plays and says what it leaves (${JSON.stringify(s[0])})`);
  await d.call('browser_close');
  await client.close();
}

// 2b. On: the options work.
{
  console.log('replay_options: on (CHROMAPHORE_REPLAY_OPTIONS "true"), on a page');
  const client = await start('true');
  const { call, js } = driver(client);
  let r = await call('browser_open', { profile: 'temp', headless: true, url: base });
  const listing = r.text;
  const notes = idIn(listing, 'textbox "Notes"');
  const editor = idIn(listing, 'textbox "Editor"');
  check(!!notes && !!editor, `the page is listed (${notes}, ${editor})`);
  const para = () => js(`document.querySelector('#ed p').textContent.replace(/ /g, ' ')`);

  // A burst at the end of the paragraph, at a set time, with its text checked.
  await call('eval_js', { expression: "(() => { const p = document.querySelector('#ed p'); p.parentElement.focus(); const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); window.__keys.length = 0; })()" });
  const when = Date.now() + 3000;
  r = await call('type', {
    keys: [' Mike nvo', { bs: 2 }, 'ovember', { pause_ms: 400 }, '.'],
    text: ' Mike november.',
    not_before: new Date(when).toISOString(),
    seed: 7,
  });
  const ran = Date.parse(/Ran from ([^\s,]+)/.exec(r.text)?.[1] ?? '');
  check(!r.isError && ran >= when && ran - when < 1000, `[on] the burst waited for not_before (began ${ran - when} ms after it)`);
  check((await para()) === 'Hotel india juliet kilo lima. Mike november.', `[on] the burst left its text: ${JSON.stringify(await para())}`);
  const keys = await js(`window.__keys.filter(k => k.key !== 'Shift' && k.key !== 'Control')`);
  check(keys.length > 0 && keys[0].t >= when, `[on] no key went out before not_before (first at ${keys[0]?.t - when} ms)`);

  // Times without a zone, and bursts the check refuses, before any key.
  r = await call('type', { text: 'x', not_before: '2026-11-16T10:00:00' });
  check(r.isError && /no time zone/.test(r.text), '[on] a not_before without a zone is refused');
  await call('click', { id: notes, quiet: true });
  await call('eval_js', { expression: reset });
  r = await call('type', { keys: ['ab', { bs: 3 }], text: '' });
  let s = await state({ js });
  check(/Nothing typed: keys leave "" and delete 1 character/.test(r.text) && nothing(s), `[on] a burst that reaches back before its start is told, not typed (${JSON.stringify(s)})`);
  r = await call('type', { keys: ['ab', { press: 'ArrowLeft' }], text: 'ab' });
  s = await state({ js });
  check(/cannot follow .*ArrowLeft.*Leave text out/.test(r.text) && nothing(s), `[on] with text, an ArrowLeft press is refused before any key (${JSON.stringify(s)})`);
  r = await call('type', { id: notes, keys: ['one', { press: 'Enter' }, 'two'], text: 'one\ntwo', quiet: true });
  s = await state({ js });
  const focused = await js(`document.activeElement?.id ?? null`);
  check(!r.isError && /it leaves "one\\ntwo"/.test(r.text) && s[0] === 'one\ntwo', `[on] with text, {"press": "Enter"} counts as a newline (${JSON.stringify(s[0])}; focus on #${focused})`);
  r = await call('type', { keys: ['ab'], text: 'abc' });
  check(/^Nothing typed: keys leave "ab", not text "abc"/.test(r.text), '[on] a burst that does not leave its text is refused');

  // not_before more than 15 minutes ahead is refused before the pointer
  // moves; a bad expect_focus id fails at once, not after the wait.
  await call('eval_js', { expression: reset });
  r = await call('type', { id: notes, text: 'late', not_before: new Date(Date.now() + 20 * 60_000).toISOString() });
  const mouse = await js('window.__mouse');
  check(r.isError && /at most 15 minutes/.test(r.text) && mouse.move === 0 && mouse.down === 0, `[on] a not_before 20 minutes ahead was refused before any pointer event (moves ${mouse.move})`);
  const t0 = Date.now();
  r = await call('type', { text: 'x', not_before: new Date(Date.now() + 10_000).toISOString(), expect_focus: 'zz999' });
  check(r.isError && Date.now() - t0 < 5000, `[on] a bad expect_focus id with not_before failed at once (${Date.now() - t0} ms)`);

  // press and paste with not_before and expect_focus.
  await call('click', { id: notes, quiet: true });
  await call('eval_js', { expression: reset });
  let when2 = Date.now() + 2500;
  r = await call('press', { keys: 'Space', not_before: new Date(when2).toISOString(), expect_focus: notes, quiet: true });
  let ran2 = Date.parse(/Ran from ([^\s,]+)/.exec(r.text)?.[1] ?? '');
  const spaceAt = (await js(`window.__keys.filter(k => k.key === ' ').map(k => k.t)`))[0];
  check(!r.isError && ran2 >= when2 && spaceAt >= when2, `[on] press waited for not_before (ran ${ran2 - when2} ms after, the key ${spaceAt - when2} ms after)`);
  when2 = Date.now() + 2500;
  r = await call('paste', { text: 'pasted', not_before: new Date(when2).toISOString(), expect_focus: notes, quiet: true });
  ran2 = Date.parse(/Ran from ([^\s,]+)/.exec(r.text)?.[1] ?? '');
  s = await state({ js });
  check(!r.isError && ran2 >= when2 && s[0] === ' pasted', `[on] paste waited for not_before with the focus checked (${JSON.stringify(s[0])})`);

  // The expect_focus id is resolved again after the wait: the field had the
  // focus when the call came, and left the page during not_before.
  const vanish = idIn((await call('observe')).text, 'textbox "Vanish field"');
  await call('click', { id: vanish, quiet: true });
  await call('eval_js', { expression: "window.__keys.length = 0; setTimeout(() => document.getElementById('vanish').remove(), 1000)" });
  r = await call('type', { text: 'late', exact: true, not_before: new Date(Date.now() + 2500).toISOString(), expect_focus: vanish });
  const afterVanish = await js(`window.__keys.length`);
  check(/^Nothing sent: .*no longer on the page/.test(r.text) && afterVanish === 0, `[on] an expect_focus element gone during the wait was found gone after it, and no key was sent (${afterVanish})`);

  // A cancel during not_before: nothing reaches the page, for type, press and
  // paste alike.
  for (const [tool, args] of [
    ['type', { text: 'wait', exact: true }],
    ['press', { keys: 'x' }],
    ['paste', { text: 'pasted' }],
  ]) {
    await call('click', { id: notes, quiet: true });
    await call('eval_js', { expression: reset });
    const ac = new AbortController();
    const until = Date.now() + 3000;
    const p = call(tool, { ...args, not_before: new Date(until).toISOString() }, ac.signal).then(() => 'answered', () => 'rejected');
    await new Promise((res) => setTimeout(res, 1000));
    ac.abort();
    const how = await p;
    await new Promise((res) => setTimeout(res, until - Date.now() + 1500));
    s = await state({ js });
    check(how === 'rejected' && nothing(s), `[on] ${tool} cancelled during not_before sent nothing (${JSON.stringify(s)})`);
  }

  // One seed gives one rhythm; another seed another.
  await call('click', { id: notes, quiet: true });
  const keyTimes = () => js(`window.__keys.filter(k => k.key.length === 1).map(k => k.ts)`);
  const gapsOf = async (seed) => {
    await call('eval_js', { expression: reset });
    await call('type', { text: 'paced words here', exact: true, seed, quiet: true });
    const k = await keyTimes();
    return k.slice(1).map((t, i) => Math.round(t - k[i]));
  };
  const g1 = await gapsOf(11);
  const g2 = await gapsOf(11);
  const g3 = await gapsOf(12);
  const most = (a, b) => Math.max(...a.map((g, i) => Math.abs(g - b[i])));
  check(g1.length === 15 && g1.length === g2.length && most(g1, g2) <= 2, `[on] the same seed gave the same gaps (largest difference ${most(g1, g2)} ms)`);
  check(most(g1, g3) > 10, `[on] another seed gave other gaps (largest difference ${most(g1, g3)} ms)`);

  // dry_run, key_log, the times from the timeline and the seed said: a
  // browser newer than release 2.0.0 only.
  const modern = !/predates/.test((await call('clipboard')).text);
  if (!modern) {
    for (const extra of [{ dry_run: true }, { key_log: path.join(os.tmpdir(), 'never.jsonl') }]) {
      await call('eval_js', { expression: reset });
      r = await call('type', { text: 'planned', exact: true, ...extra });
      s = await state({ js });
      check(r.isError && /^This browser predates (planning keys without sending them \(dry_run\)|logging the key events \(key_log\)): it needs a Chromaphore build newer than release 2\.0\.0\. Nothing was done\.$/.test(r.text) && nothing(s), `[on] ${Object.keys(extra)[0]} on this browser is refused in one sentence (${r.text})`);
    }
    r = await call('type', { text: 'abc', exact: true, quiet: true });
    check(!r.isError && !/^Seed /m.test(r.text), '[on] this browser answers no seed line');
    console.log('SKIP dry_run, key_log, the key times from the timeline and the seed said: this browser predates the timeline of Input.dispatchKeystrokes (a Chromaphore build newer than release 2.0.0 has it)');
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-keylog-'));
    const log = path.join(dir, 'made', 'keys.jsonl');
    const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const burst = ['Plan ahead', { bs: 2 }, 'ad', { pause_ms: 300 }, '!'];
    // A plan, nothing sent.
    await call('click', { id: notes, quiet: true });
    await call('eval_js', { expression: reset });
    r = await call('type', { keys: burst, dry_run: true, key_log: log });
    s = await state({ js });
    const planned = /^Planned, nothing sent: from its first key down to its last key up it would take [\d.]+ s \((\d+) ms[^)]*\), (\d+) key event\(s\)/.exec(r.text);
    const seedOf = /^Seed (\d+) \(typos (?:not )?allowed\): pass it back as seed/m.exec(r.text);
    check(!r.isError && !!planned && !!seedOf && nothing(s), `[on] dry_run plans the burst, says its length and seed, and sends nothing (${JSON.stringify(s)}; ${r.text.split('\n').slice(0, 2).join(' | ')})`);
    const plan = lines();
    check(plan.length === 1 && plan[0].dryRun === true && plan[0].seed === Number(seedOf?.[1]) && plan[0].events.length === Number(planned?.[2]) && new RegExp(`Logged ${plan[0].events.length} key event\\(s\\) as planned to `).test(r.text), `[on] dry_run with key_log logs the plan, its folder made (${plan.length} line(s))`);
    // The seed passed back gives that schedule.
    r = await call('type', { keys: burst, seed: Number(seedOf?.[1]), key_log: log, quiet: true });
    s = await state({ js });
    const real = lines()[1];
    const sameKeys = !!real && real.events.length === plan[0].events.length && real.events.every((e, i) => e.key === plan[0].events[i].key && e.event === plan[0].events[i].event && Math.abs(e.timeMs - plan[0].events[i].timeMs) < 20);
    check(!r.isError && s[0] === 'Plan ahead!' && sameKeys, `[on] typing with the seed dry_run gave plays that schedule: the same key events within 20 ms (${real?.events.length} events; ${JSON.stringify(s[0])})`);
    check(!!real && typeof real.startEpochMs === 'number' && real.start === new Date(real.startEpochMs).toISOString() && real.seed === Number(seedOf?.[1]) && typeof real.durationMs === 'number' && typeof real.typosAllowed === 'boolean' && real.typos === 0 && !real.stopped && !real.dryRun, `[on] the key log's line has the start, seed, length, typo decision and count (${JSON.stringify({ ...real, events: real?.events.length })})`);
    check(new RegExp(`Logged ${real?.events.length} key event\\(s\\) to .*keys\\.jsonl\\.`).test(r.text) && /^Seed \d+ \(typos (not )?allowed\)/m.test(r.text), '[on] the answer says how many events went to which file, and the seed');
    // The time line from the timeline, against the page's own clock.
    await call('eval_js', { expression: reset });
    const when3 = Date.now() + 2500;
    r = await call('type', { text: 'timed', exact: true, not_before: new Date(when3).toISOString(), quiet: true });
    const t = /^Ran from (\S+) \(the first key down, (\d+) ms after not_before\) to (\S+) \(the last key up\), (\d+) ms\.$/m.exec(r.text);
    const firstKey = (await js('window.__keys[0]?.t ?? 0'));
    const from = Date.parse(t?.[1] ?? ''), to = Date.parse(t?.[3] ?? '');
    check(!!t && from >= when3 && Math.abs(from - when3 - Number(t[2])) <= 1 && Math.abs(firstKey - from) <= 50 && to - from === Number(t[4]) && to > from, `[on] with not_before the answer times the first key down and the last key up from the timeline (${t?.[0]}; the page saw the first key ${firstKey - from} ms off)`);
    // The seed said for a call that gave none, and the one given.
    r = await call('type', { text: 'x', exact: true, quiet: true });
    const drawn = /^Seed (\d+) \(typos (not )?allowed\)/m.exec(r.text);
    r = await call('type', { text: 'y', exact: true, seed: 4242, quiet: true });
    check(!!drawn && Number(drawn[1]) > 0 && /^Seed 4242 \(typos (not )?allowed\)/m.test(r.text), `[on] the answer says the seed used, drawn (${drawn?.[1]}) or given`);
    // What dry_run cannot go with, refused before anything moves; the text
    // check still applies.
    await call('eval_js', { expression: reset });
    r = await call('type', { id: notes, text: 'x', dry_run: true, clear: true, submit: true, expect_focus: notes, not_before: Date.now() + 5000 });
    s = await state({ js });
    const mouse2 = await js('window.__mouse');
    check(r.isError && r.text === 'dry_run sends nothing and waits for nothing, so id, clear, submit, not_before, expect_focus cannot go with it. Nothing was done.' && nothing(s) && mouse2.down === 0, `[on] dry_run with id, clear, submit, not_before and expect_focus is refused, naming them (${r.text})`);
    r = await call('type', { keys: ['ab'], text: 'abc', dry_run: true });
    check(/^Nothing typed: keys leave "ab", not text "abc"/.test(r.text), '[on] dry_run keeps the text check');
    // A log that cannot be written is a line of the answer, which keeps the rest.
    await call('eval_js', { expression: reset });
    const blocked = path.join(dir, 'a-file');
    fs.writeFileSync(blocked, 'x');
    r = await call('type', { text: 'kept', exact: true, key_log: path.join(blocked, 'keys.jsonl'), quiet: true });
    s = await state({ js });
    check(!r.isError && /^Typed 4 character\(s\)/.test(r.text) && /^The key log could not be written to .*keys\.jsonl: /m.test(r.text) && s[0] === 'kept', `[on] a key log that cannot be written is told, and the answer keeps the rest (${JSON.stringify(s[0])})`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  await call('browser_close');
  await client.close();
}

site.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
