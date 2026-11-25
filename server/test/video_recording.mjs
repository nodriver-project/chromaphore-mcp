// Live end-to-end test of agent video recording through the MCP server.
// Usage: node test/video_recording.mjs [server.mjs]
// (CHROMAPHORE_TEST_BROWSER names the chrome.exe; else the installed release.)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = process.argv[2] ?? path.resolve(here, '../../plugin/dist/server.mjs');

const page1 = `<!doctype html><meta charset="utf-8"><title>Video Page 1</title>
<style>body{font:18px Arial;padding:24px;background:#f7f9fc} button{padding:8px 16px} input{padding:6px;width:240px}</style>
<h1>Page One</h1>
<button id="btn" onclick="document.getElementById('out').textContent = 'clicked ' + (++window.__n)">Click me</button>
<input id="box" aria-label="Message" />
<div id="out">ready</div>
<script>window.__n = 0;</script>`;

const page2 = `<!doctype html><meta charset="utf-8"><title>Video Page 2</title>
<style>body{font:18px Arial;padding:24px;background:#fff4e6}</style>
<h1>Page Two</h1><p>Second tab content.</p>`;

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url === '/two' ? page2 : page1);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const env = { ...process.env };
if (env.CHROMAPHORE_TEST_BROWSER) env.CHROMAPHORE_BROWSER = env.CHROMAPHORE_TEST_BROWSER;
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env });
const client = new Client({ name: 'video-test', version: '1.0' });
await client.connect(transport);

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`  ${name} ${JSON.stringify(args)}: ${r.isError ? 'ERROR ' : ''}${text.split('\n')[0]}`);
  return { ...r, text };
};
const idIn = (listing, re) => {
  const line = listing.split('\n').find((l) => re.test(l));
  return line?.match(/^\s*([a-z]+\d+)\b/)?.[1] ?? null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isMp4 = (file) => {
  if (!fs.existsSync(file)) return false;
  const buf = fs.readFileSync(file);
  return buf.length > 1024 && buf.subarray(4, 8).toString('ascii') === 'ftyp';
};
const readEvents = (file) =>
  fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chromaphore-video-'));

try {
  // 1. Open headless browser on Page 1.
  let r = await call('browser_open', { profile: 'temp', headless: true, url: base });
  check(!r.isError, 'browser_open succeeded');
  const obs = await call('observe');
  const btnId = idIn(obs.text, /button.*"Click me"/i);
  const boxId = idIn(obs.text, /textbox.*"Message"/i);
  check(!!btnId && !!boxId, `found controls (${btnId}, ${boxId})`);

  // 2. Start video recording with idle: "cut".
  const file1 = path.join(outDir, 'flow.mp4');
  const events1 = path.join(outDir, 'flow.events.ndjson');
  r = await call('video_start', { path: file1, fps: 10, idle: 'cut', audio: false });
  if (r.isError && /not built with a video recorder/.test(r.text)) {
    console.log('SKIP video recording live checks: installed browser predates Browser.startVideoRecording');
    await call('browser_close');
    process.exit(0);
  }
  check(!r.isError && /^Recording .*flow\.mp4 at \d+x\d+, 10 fps; it ends itself after 10 min/.test(r.text), `video_start succeeded (${r.text})`);

  // Second video_start while running is refused.
  r = await call('video_start', { path: path.join(outDir, 'second.mp4'), fps: 10, idle: 'keep' });
  check(r.isError && /already recording/.test(r.text), 'second video_start refused while active');

  // Wait > 1 s so idle: "cut" pauses the recording.
  await sleep(1350);

  // Marked actions: click & type. Unmarked: observe.
  r = await call('click', { id: btnId, quiet: true });
  check(!r.isError, 'click succeeded during recording');
  r = await call('type', { id: boxId, text: 'hello video', exact: true, quiet: true });
  check(!r.isError, 'type succeeded during recording');
  r = await call('observe');
  check(!r.isError, 'observe succeeded during recording');

  // Custom mark, agent pause & resume.
  r = await call('video_mark', { label: 'after typing' });
  check(!r.isError && /^Marked at /.test(r.text), `video_mark succeeded (${r.text})`);
  r = await call('video_pause');
  check(!r.isError && /^Paused at /.test(r.text), `video_pause succeeded (${r.text})`);
  r = await call('video_resume');
  check(!r.isError && /^Resumed at /.test(r.text), `video_resume succeeded (${r.text})`);
  r = await call('video_resume');
  check(!r.isError && /^It was not paused at /.test(r.text), `second video_resume says not paused (${r.text})`);

  // Tab switch: recording should follow the new tab.
  r = await call('tab_new', { url: `${base}/two` });
  check(!r.isError, 'tab_new succeeded during recording');
  await sleep(400);

  // Stop and inspect MP4 + events sidecar.
  r = await call('video_stop');
  check(!r.isError && /^Saved .*flow\.mp4: .*frame/.test(r.text) && /Events: .*flow\.events\.ndjson\.$/.test(r.text), `video_stop succeeded (${r.text})`);
  check(isMp4(file1), `flow.mp4 exists and is a valid MP4 (${fs.existsSync(file1) ? fs.statSync(file1).size : 0} bytes)`);
  check(fs.existsSync(events1), 'flow.events.ndjson exists');

  const evs = readEvents(events1);
  const startEv = evs.find((e) => e.type === 'start');
  check(!!startEv && startEv.redacted === false && typeof startEv.url === 'string', `sidecar start has redacted:false and url (${JSON.stringify(startEv)})`);
  check(evs.some((e) => e.type === 'pause' && e.label === 'idle') && evs.some((e) => e.type === 'resume' && e.label === 'idle'), 'sidecar records idle pause and resume');
  check(evs.some((e) => e.type === 'tool' && e.tool === 'click' && e.at === 'start') && evs.some((e) => e.type === 'tool' && e.tool === 'click' && e.at === 'end' && e.ok === true), 'sidecar marks click start/end');
  check(evs.some((e) => e.type === 'tool' && e.tool === 'type' && e.at === 'start') && evs.some((e) => e.type === 'tool' && e.tool === 'type' && e.at === 'end' && e.ok === true), 'sidecar marks type start/end');
  check(!evs.some((e) => e.type === 'tool' && (e.tool === 'observe' || e.tool?.startsWith('video_'))), 'sidecar does not mark observe or video_*');
  check(evs.some((e) => e.label === 'after typing'), 'sidecar holds custom video_mark label');
  check(evs.some((e) => e.type === 'pause' && e.label === 'agent') && evs.some((e) => e.type === 'resume' && e.label === 'agent'), 'sidecar records agent pause and resume');
  check(evs.some((e) => e.type === 'target'), 'sidecar records tab switch (target)');

  // 3. Unexpected end (closing the recorded tab with no previous tab left) -> notice + video_stop figures.
  // Close t1 so t2 is the only tab, start recording on t2, then close t2.
  await call('tab_close', { tab: 't1' });
  const file2 = path.join(outDir, 'closed-tab.mp4');
  r = await call('video_start', { path: file2, fps: 10, idle: 'keep', audio: false });
  check(!r.isError, 'second recording started on remaining tab');
  await sleep(400);
  // Open another tab? No, keep only t2? Wait: closing the last tab closes the browser!
  // Instead, open t3 BEFORE starting recording on t3, never switch from t2 -> t3 during recording,
  // so t3 has no previous recorded tab to return to, and closing t3 ends the recording with targetClosed!
  await call('video_stop');
  await call('tab_new', { url: base });
  const tabsText = (await call('tab_list')).text;
  const activeTab = tabsText.split('\n').find((l) => l.startsWith('*'))?.match(/^\*\s+(t\d+)/)?.[1];
  const file3 = path.join(outDir, 'target-closed.mp4');
  r = await call('video_start', { path: file3, fps: 10, idle: 'keep', audio: false });
  check(!r.isError && !!activeTab, `recording started on ${activeTab} for targetClosed check`);
  await sleep(400);
  const closeRes = await call('tab_close', { tab: activeTab });
  await sleep(500);
  const listRes = await call('tab_list');
  const sawNotice = /\[since your last call\] Your video recording ended when its tab closed:/.test(closeRes.text)
    || /\[since your last call\] Your video recording ended when its tab closed:/.test(listRes.text);
  check(sawNotice, `unexpected end notice shown once on next reply (${listRes.text.split('\n')[0]})`);
  const listRes2 = await call('tab_list');
  check(!/\[since your last call\]/.test(listRes2.text), 'ended notice is not repeated');
  const stopEnded = await call('video_stop');
  check(!stopEnded.isError && /^It had already ended when its tab closed\. Saved .*target-closed\.mp4: /.test(stopEnded.text), `video_stop reports ended figures (${stopEnded.text})`);
  check(isMp4(file3), 'target-closed.mp4 is a valid MP4');

  // 4. browser_close cleanly finalizes an active video recording.
  const otherTab = listRes2.text.split('\n')[0]?.match(/\b(t\d+)\b/)?.[1];
  await call('tab_select', { tab: otherTab });
  const file4 = path.join(outDir, 'on-close.mp4');
  r = await call('video_start', { path: file4, fps: 10, idle: 'keep', audio: false });
  check(!r.isError, 'recording started for browser_close check');
  await sleep(500);
  r = await call('browser_close');
  check(!r.isError, 'browser_close succeeded while recording');
  check(isMp4(file4), `on-close.mp4 finalized cleanly by browser_close (${fs.existsSync(file4) ? fs.statSync(file4).size : 0} bytes)`);
} finally {
  await call('browser_close').catch(() => {});
  await client.close().catch(() => {});
  site.close();
  fs.rmSync(outDir, { recursive: true, force: true });
}

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
