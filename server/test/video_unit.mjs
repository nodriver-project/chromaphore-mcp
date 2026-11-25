// VideoRecorder and path resolution unit tests without a browser.
// Usage: node test/video_unit.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-unit-'));
await build({
  entryPoints: [path.resolve(here, '../src/video.ts'), path.resolve(here, '../src/cdp.ts')],
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  outdir: tmp,
  outExtension: { '.js': '.mjs' },
  logLevel: 'error',
});
const v = await import(pathToFileURL(path.join(tmp, 'video.mjs')).href);
const cdp = await import(pathToFileURL(path.join(tmp, 'cdp.mjs')).href);

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const refused = async (fn, re) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return re.test(e instanceof Error ? e.message : String(e));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Path resolution ---
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'video-paths-'));
const def = v.resolveVideoPath(undefined, work);
check(
  path.dirname(def) === path.join(work, 'recordings') && /^video-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.mp4$/.test(path.basename(def)),
  `default path lands in <cwd>/recordings/video-<stamp>.mp4 (${def})`,
);

const bare = v.resolveVideoPath('checkout', work);
check(bare === path.join(work, 'recordings', 'checkout.mp4'), `bare name goes into recordings/<name>.mp4 (${bare})`);
const bareExt = v.resolveVideoPath('checkout.MP4', work);
check(bareExt === path.join(work, 'recordings', 'checkout.mp4'), 'bare name with .MP4 does not double extension');

fs.mkdirSync(path.join(work, 'recordings'), { recursive: true });
fs.writeFileSync(path.join(work, 'recordings', 'checkout.mp4'), '');
const num2 = v.resolveVideoPath('checkout', work);
check(num2 === path.join(work, 'recordings', 'checkout (2).mp4'), 'existing .mp4 auto-numbers to (2)');
fs.writeFileSync(path.join(work, 'recordings', 'checkout (2).events.ndjson'), '');
const num3 = v.resolveVideoPath('checkout', work);
check(num3 === path.join(work, 'recordings', 'checkout (3).mp4'), 'existing .events.ndjson auto-numbers to (3)');

const rel = v.resolveVideoPath('sub/demo', work);
check(rel === path.join(work, 'sub', 'demo.mp4'), `relative path resolves under cwd (${rel})`);

check(await refused(() => v.resolveVideoPath('CON', work), /Windows keeps for a device/), 'CON refused');
check(await refused(() => v.resolveVideoPath('nul.mp4', work), /Windows keeps for a device/), 'nul.mp4 refused');
check(await refused(() => v.resolveVideoPath('sub/COM1.mp4', work), /Windows keeps for a device/), 'COM1 in path refused');
check(await refused(() => v.resolveVideoPath('   ', work), /cannot be empty/), 'blank path refused');
check(await refused(() => v.resolveVideoPath('sub/', work), /not a folder/), 'trailing slash refused');

// --- Fake CDP sender ---
function fakeSender(handlers = {}) {
  const calls = [];
  return {
    calls,
    async send(method, params = {}) {
      calls.push({ method, params });
      if (handlers[method]) return handlers[method](params, calls);
      throw new Error(`unexpected method ${method}`);
    },
  };
}

// 1. Browser without recorder (-32601)
{
  const sender = fakeSender({
    'Browser.videoRecordingStatus': () => {
      throw new cdp.CdpError('Browser.videoRecordingStatus', -32601, "'Browser.videoRecordingStatus' wasn't found");
    },
  });
  const rec = new v.VideoRecorder(sender);
  check(
    await refused(() => rec.start({ targetId: 'T1', fps: 10, idle: 'cut', cwd: work }), /not built with a video recorder/),
    'older browser (-32601) refused clearly',
  );
  check(!rec.busy(), 'slot is free after -32601 refusal');
}

// 2. External recording already running
{
  const sender = fakeSender({
    'Browser.videoRecordingStatus': () => ({ recording: true, recordingId: 'ext-1', state: 'recording' }),
  });
  const rec = new v.VideoRecorder(sender);
  check(
    await refused(() => rec.start({ targetId: 'T1', fps: 10, idle: 'cut', cwd: work }), /did not start/),
    'external recording refused without touching it',
  );
  check(sender.calls.length === 1, 'no start or stop sent for external recording');
}

// 3. idle: "cut" + agent pause/resume + marks + tab follow + stop
{
  let paused = false;
  let timeMs = 1500;
  const sender = fakeSender({
    'Browser.videoRecordingStatus': () => ({ recording: true, recordingId: 'r1', state: paused ? 'paused' : 'recording', mediaTimeMs: timeMs }),
    'Browser.startVideoRecording': (p) => {
      check(p.redact === false, 'startVideoRecording passes redact: false');
      return { recordingId: 'r1', width: 1280, height: 720, eventsPath: v.eventsOf(p.path) };
    },
    'Browser.pauseVideoRecording': () => {
      paused = true;
      return { mediaTimeMs: (timeMs += 500) };
    },
    'Browser.resumeVideoRecording': () => {
      paused = false;
      return { mediaTimeMs: (timeMs += 500) };
    },
    'Browser.markVideoRecording': () => ({ mediaTimeMs: (timeMs += 200) }),
    'Browser.setVideoRecordingTarget': () => ({}),
    'Browser.stopVideoRecording': () => ({
      result: { path: path.join(work, 'recordings', 'flow.mp4'), eventsPath: path.join(work, 'recordings', 'flow.events.ndjson'), durationMs: 4200, frames: 42, dropped: 1, bytes: 1048576, reason: 'stopped' },
    }),
  });
  // First status check before start returns recording: false.
  let started = false;
  const origStatus = sender.send.bind(sender);
  const wrap = {
    calls: sender.calls,
    send(m, p) {
      if (m === 'Browser.videoRecordingStatus' && !started) {
        sender.calls.push({ method: m, params: p });
        return Promise.resolve({ recording: false });
      }
      if (m === 'Browser.startVideoRecording') started = true;
      return origStatus(m, p);
    },
  };
  const rec = new v.VideoRecorder(wrap, { idleAfterMs: 40 });
  const startMsg = await rec.start({ targetId: 'T1', path: 'flow', fps: 10, idle: 'cut', cwd: work });
  check(/Recording .*flow\.mp4 at 1280x720, 10 fps/.test(startMsg), `start reply formatted (${startMsg})`);

  // Wait for idle cut to pause.
  await sleep(90);
  check(paused === true && wrap.calls.some((c) => c.method === 'Browser.pauseVideoRecording' && c.params.label === 'idle'), 'idle cut paused browser after idleAfterMs');

  // Agent pause while already idle-paused: no duplicate pause sent, holds 'agent'.
  const pauseCountBefore = wrap.calls.filter((c) => c.method === 'Browser.pauseVideoRecording').length;
  const pauseMsg = await rec.pause();
  check(
    /^Paused at 0:02, 9:58 left\.$/.test(pauseMsg) && wrap.calls.filter((c) => c.method === 'Browser.pauseVideoRecording').length === pauseCountBefore,
    `agent pause while idle-paused sends no duplicate pause (${pauseMsg})`,
  );

  // toolStarted removes 'idle', but 'agent' still holds pause -> stays paused.
  await rec.toolStarted('click');
  check(paused === true, 'toolStarted keeps browser paused while agent hold is active');
  await rec.toolEnded('click', true);

  // Agent resume while still inside idle grace (before 40 ms): resumes immediately!
  const resumeMsg = await rec.resume();
  check(paused === false && /^Resumed at /.test(resumeMsg), `agent resume resumes when idle hold is not set (${resumeMsg})`);

  // Calling resume again says not paused.
  const notPaused = await rec.resume();
  check(/^It was not paused at /.test(notPaused), `second resume says not paused (${notPaused})`);

  // Mark trims and caps at 500 chars.
  const longLabel = '  ' + 'x'.repeat(600) + '  ';
  const markMsg = await rec.mark(longLabel);
  const lastMark = wrap.calls.filter((c) => c.method === 'Browser.markVideoRecording').at(-1);
  check(/^Marked at /.test(markMsg) && JSON.parse(lastMark.params.event).label.length === 500, 'mark caps label at 500 chars');

  // Follow tab switch.
  await rec.follow('T2');
  check(wrap.calls.some((c) => c.method === 'Browser.setVideoRecordingTarget' && c.params.targetId === 'T2'), 'follow sends setVideoRecordingTarget');

  // Stop.
  const stopMsg = await rec.stop();
  check(/Saved .*flow\.mp4: 0:04, 1\.0 MB, 42 frames \(1 dropped\)\. Events: .*flow\.events\.ndjson\.$/.test(stopMsg), `stop formats figures (${stopMsg})`);
  check(!rec.busy(), 'slot is free after stop');
}

// 4. Pause timeout -> resync on next resume
{
  let pauseTimedOut = false;
  let started = false;
  const sender = fakeSender({
    'Browser.videoRecordingStatus': () =>
      started ? { recording: true, recordingId: 'r2', state: 'paused', mediaTimeMs: 3000 } : { recording: false },
    'Browser.startVideoRecording': (p) => {
      started = true;
      return { recordingId: 'r2', width: 800, height: 600, eventsPath: v.eventsOf(p.path) };
    },
    'Browser.pauseVideoRecording': () => {
      pauseTimedOut = true;
      throw new Error('Browser.pauseVideoRecording got no answer within 10 s');
    },
    'Browser.resumeVideoRecording': () => ({ mediaTimeMs: 3000 }),
  });
  const rec = new v.VideoRecorder(sender);
  await rec.start({ targetId: 'T1', path: 'resync', fps: 10, idle: 'keep', cwd: work });
  check(await refused(() => rec.pause(), /did not answer in time/), 'pause timeout reported cleanly');
  const rMsg = await rec.resume();
  check(pauseTimedOut && /^Resumed at 0:03/.test(rMsg), `resume resynced status after pause timeout (${rMsg})`);
}

// 5. Unexpected Browser.videoRecordingEnded -> one-shot notice + full figures on stop
{
  let started = false;
  const mp4 = path.join(work, 'recordings', 'ended.mp4');
  const ndjson = v.eventsOf(mp4);
  const sender = fakeSender({
    'Browser.videoRecordingStatus': () => ({ recording: started }),
    'Browser.startVideoRecording': (p) => {
      started = true;
      return { recordingId: 'r3', width: 800, height: 600, eventsPath: v.eventsOf(p.path) };
    },
  });
  const rec = new v.VideoRecorder(sender);
  await rec.start({ targetId: 'T1', path: 'ended', fps: 10, idle: 'keep', cwd: work });
  rec.onEnded({
    recordingId: 'r3',
    result: { path: mp4, eventsPath: ndjson, durationMs: 600_000, frames: 6000, dropped: 0, bytes: 5_242_880, reason: 'timeLimit' },
  });
  const notice1 = rec.takeEndedNotice();
  const notice2 = rec.takeEndedNotice();
  check(
    /^\[since your last call\] Your video recording ended at its time limit: .*ended\.mp4\. video_stop gives its figures\.$/.test(notice1 ?? '') && notice2 === null,
    `ended notice fires once (${notice1})`,
  );
  const stopMsg = await rec.stop();
  check(
    /^It had already ended at its time limit\. Saved .*ended\.mp4: 10:00, 5\.0 MB, 6000 frames\. Events: .*ended\.events\.ndjson\.$/.test(stopMsg),
    `video_stop returns full figures after ended (${stopMsg})`,
  );
  check(await refused(() => rec.stop(), /Nothing is recording/), 'second stop says nothing is recording');
}

// 6. Start timeout recovery stops recording and deletes files
{
  const mp4 = path.join(work, 'recordings', 'ghost.mp4');
  const ndjson = v.eventsOf(mp4);
  let statusCalls = 0;
  const sender = fakeSender({
    'Browser.videoRecordingStatus': () => {
      statusCalls++;
      if (statusCalls === 1) return { recording: false };
      return { recording: true, recordingId: 'r-ghost', state: 'recording' };
    },
    'Browser.startVideoRecording': () => {
      fs.writeFileSync(mp4, 'partial');
      fs.writeFileSync(ndjson, 'partial');
      throw new Error('Browser.startVideoRecording got no answer within 30 s');
    },
    'Browser.stopVideoRecording': () => ({ result: { path: mp4, eventsPath: ndjson } }),
  });
  const rec = new v.VideoRecorder(sender, { startSettleMs: 500, pollMs: 20 });
  check(
    await refused(() => rec.start({ targetId: 'T1', path: 'ghost', fps: 10, idle: 'keep', cwd: work }), /what it began was stopped and its files deleted/),
    'timed-out start settles, stops and deletes files',
  );
  check(!fs.existsSync(mp4) && !fs.existsSync(ndjson) && !rec.busy(), 'ghost files deleted and slot freed');
}

// 7. Stop timeout -> owed stop settled on retry
{
  let started = false;
  let stopAttempts = 0;
  const mp4 = path.join(work, 'recordings', 'owed.mp4');
  const ndjson = v.eventsOf(mp4);
  const sender = fakeSender({
    'Browser.videoRecordingStatus': () =>
      started
        ? { recording: stopAttempts < 2, recordingId: 'r4', state: 'recording' }
        : { recording: false },
    'Browser.startVideoRecording': (p) => {
      started = true;
      return { recordingId: 'r4', width: 800, height: 600, eventsPath: v.eventsOf(p.path) };
    },
    'Browser.stopVideoRecording': () => {
      stopAttempts++;
      if (stopAttempts === 1) throw new Error('Browser.stopVideoRecording got no answer within 60 s');
      return { result: { path: mp4, eventsPath: ndjson, durationMs: 2000, frames: 20, dropped: 0, bytes: 204800, reason: 'stopped' } };
    },
  });
  const rec = new v.VideoRecorder(sender, { stoppingWaitMs: 500, pollMs: 20 });
  await rec.start({ targetId: 'T1', path: 'owed', fps: 10, idle: 'keep', cwd: work });
  check(await refused(() => rec.stop(), /Calling video_stop again is safe/), 'first stop timeout says retry is safe');
  check(rec.busy(), 'slot stays busy while stop is owed');
  const retryMsg = await rec.stop();
  check(/^Saved .*owed\.mp4: 0:02, 0\.2 MB, 20 frames\./.test(retryMsg) && !rec.busy(), `second stop settles and frees slot (${retryMsg})`);
}

// 8. Overlapping action calls under idle: "cut", resume while idle-paused, emoji mark cap, shutDown Saved line
{
  let paused = false;
  let lastMark = null;
  const mp4 = path.join(work, 'recordings', 'overlap.mp4');
  const ndjson = v.eventsOf(mp4);
  const sender = fakeSender({
    'Browser.videoRecordingStatus': () => ({ recording: true, recordingId: 'r5', state: paused ? 'paused' : 'recording', mediaTimeMs: 1500 }),
    'Browser.startVideoRecording': (p) => ({ recordingId: 'r5', width: 800, height: 600, eventsPath: v.eventsOf(p.path) }),
    'Browser.pauseVideoRecording': () => {
      paused = true;
      return { mediaTimeMs: 1500 };
    },
    'Browser.resumeVideoRecording': () => {
      paused = false;
      return { mediaTimeMs: 1500 };
    },
    'Browser.markVideoRecording': (p) => {
      lastMark = JSON.parse(p.event).label;
      return { mediaTimeMs: 1500 };
    },
    'Browser.stopVideoRecording': () => ({
      result: { path: mp4, eventsPath: ndjson, durationMs: 3000, frames: 30, dropped: 0, bytes: 307200, reason: 'stopped' },
    }),
  });
  let started = false;
  const senderWrap = {
    send(method, params, sessionId, timeoutMs) {
      if (method === 'Browser.videoRecordingStatus' && !started) return Promise.resolve({ recording: false });
      if (method === 'Browser.startVideoRecording') started = true;
      return sender.send(method, params, sessionId, timeoutMs);
    },
  };
  const rec = new v.VideoRecorder(senderWrap, { idleAfterMs: 40 });
  await rec.start({ targetId: 'T1', path: 'overlap', fps: 10, idle: 'cut', cwd: work });

  // Wait for initial idle pause, then agent pause + resume while idle hold is still active.
  await new Promise((r) => setTimeout(r, 90));
  check(paused === true, 'overlap test entered idle pause');
  await rec.pause();
  const resumeIdleMsg = await rec.resume();
  check(
    paused === true && /records again from the next action/.test(resumeIdleMsg),
    `resume while idle hold stays active explains idle cut (${resumeIdleMsg})`,
  );

  // Two overlapping actions: finishing the first must not pause while the second is still in flight.
  await rec.toolStarted('type');
  await rec.toolStarted('scroll');
  await rec.toolEnded('scroll', true);
  await new Promise((r) => setTimeout(r, 90));
  check(paused === false, 'first overlapping tool ending does not idle-pause while second is in flight');
  await rec.toolEnded('type', true);
  await new Promise((r) => setTimeout(r, 90));
  check(paused === true, 'idle pause engages once all overlapping tools finish');

  // Emoji mark cap must not split a surrogate pair.
  await rec.mark('a'.repeat(499) + '\u{1F600}tail');
  check([...lastMark].length === 500 && lastMark.endsWith('\u{1F600}'), 'mark caps by code point without splitting emoji');

  // shutDown returns the Saved line.
  const savedLine = await rec.shutDown(5000);
  check(/^Saved .*overlap\.mp4: 0:03, 0\.3 MB, 30 frames\./.test(savedLine ?? ''), `shutDown returns Saved line (${savedLine})`);
}

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(work, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
