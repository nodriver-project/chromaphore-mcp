// Phase 0 spike, second part: is the zero window size at first script a
// protocol navigation's mark, or every navigation into a new renderer's?
// Each case loads /a, which then goes to /b one way or another; /b reports
// what its first script saw. Cross-site uses localhost against 127.0.0.1.
// Usage: node spike_window2.mjs [chrome.exe]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EXE, BASE_SWITCHES, headSwitches, launchPipe } from './cdp_pipe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? DEFAULT_EXE;
const scratch = path.resolve(here, '../../.scratch');

const REPORT = `<!doctype html><title>b</title><body><script>
const atLoad = { outer: outerWidth + 'x' + outerHeight, screenXY: screenX + ',' + screenY, focus: document.hasFocus() };
fetch('/result', { method: 'POST', body: JSON.stringify({ href: location.href, atLoad }) });
</script>`;
// /a?go=<url>: goes there by itself after a moment (renderer-initiated).
const START = (go) => `<!doctype html><title>a</title><body><a id=l href="${go ?? '#'}">next</a><script>
${go ? 'setTimeout(() => { location.href = document.getElementById("l").href; }, 1500);' : ''}
</script>`;

let waiting = null;
const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.end();
      waiting?.(JSON.parse(b));
    });
    return;
  }
  const u = new URL(req.url, 'http://x');
  res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
  res.end(u.pathname === '/b' ? REPORT : START(u.searchParams.get('go')));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
// localhost must reach the same server: listen on ::1 too when it resolves there.
const server6 = http.createServer((req, res) => server.emit('request', req, res));
await new Promise((r) => server6.listen(port, '::1', r)).catch(() => {});
const same = `http://127.0.0.1:${port}`;
const cross = `http://localhost:${port}`;
const result = () =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no result')), 20000);
    waiting = (r) => {
      clearTimeout(t);
      resolve(r);
    };
  });

function profileDir() {
  const p = path.join(scratch, 'profiles', `window2-${Date.now()}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}
const kill = (pid) => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });

// No protocol at all: the start page navigates by itself.
async function plain(headless, go) {
  const r = result();
  const proc = spawn(
    exe,
    [
      `--user-data-dir=${profileDir()}`,
      '--fingerprint-seed=12345',
      ...BASE_SWITCHES.filter((s) => s !== '--no-startup-window'),
      ...headSwitches(headless),
      `${same}/a?go=${encodeURIComponent(go)}`,
    ],
    { stdio: 'ignore' },
  );
  try {
    return await r;
  } finally {
    kill(proc.pid);
  }
}

// Over the pipe: a tab opened on /a, then `how` takes it to `to`.
async function driven(headless, to, how) {
  const cdp = launchPipe(exe, [
    `--user-data-dir=${profileDir()}`,
    '--fingerprint-seed=12345',
    ...BASE_SWITCHES,
    ...headSwitches(headless),
  ]);
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: `${same}/a`, newWindow: true });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await new Promise((r) => setTimeout(r, 1500));
    const r = result();
    if (how === 'Page.navigate') {
      await cdp.send('Page.navigate', { url: to }, sessionId);
    } else {
      await cdp.send('Runtime.evaluate', { expression: `location.href = ${JSON.stringify(to)}` }, sessionId);
    }
    return await r;
  } finally {
    await cdp.send('Browser.close').catch(() => {});
    kill(cdp.proc.pid);
  }
}

const CASES = [
  ['no protocol: page goes same-site', (h) => plain(h, `${same}/b`)],
  ['no protocol: page goes cross-site', (h) => plain(h, `${cross}/b`)],
  ['pipe: Page.navigate same-site', (h) => driven(h, `${same}/b`, 'Page.navigate')],
  ['pipe: Page.navigate cross-site', (h) => driven(h, `${cross}/b`, 'Page.navigate')],
  ['pipe: location.href cross-site', (h) => driven(h, `${cross}/b`, 'script')],
];
for (const headless of [false, true]) {
  for (const [name, run] of CASES) {
    try {
      const r = await run(headless);
      console.log(`${headless ? 'headless' : 'headed  '} ${name.padEnd(38)} ${JSON.stringify(r.atLoad)}`);
    } catch (e) {
      console.log(`${headless ? 'headless' : 'headed  '} ${name.padEnd(38)} FAIL ${e.message}`);
    }
  }
}
server.close();
server6.close();
