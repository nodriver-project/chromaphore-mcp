// Phase 0 spike: which way of opening the agent's window gives a page a
// window like a person's. Reports outerWidth/outerHeight and focus at load
// and 2 s later for each way of getting a tab.
// Usage: node spike_window.mjs [chrome.exe]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EXE, BASE_SWITCHES, headSwitches, launchPipe } from './cdp_pipe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? DEFAULT_EXE;
const scratch = path.resolve(here, '../../.scratch');

const PAGE = `<!doctype html><title>w</title><body><script>
const read = () => ({ outer: outerWidth + 'x' + outerHeight, inner: innerWidth + 'x' + innerHeight,
  screenXY: screenX + ',' + screenY, focus: document.hasFocus(), vis: document.visibilityState });
const atLoad = read();
setTimeout(() => fetch('/result', { method: 'POST', body: JSON.stringify({ atLoad, later: read() }) }), 2000);
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
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const result = () =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no result')), 15000);
    waiting = (r) => {
      clearTimeout(t);
      resolve(r);
    };
  });

async function navigateAndRead(cdp, sessionId) {
  await cdp.send('Page.enable', {}, sessionId);
  const r = result();
  await cdp.send('Page.navigate', { url }, sessionId);
  return r;
}

const WAYS = {
  // --no-startup-window, then a new window from the protocol.
  'createTarget newWindow': async (cdp) => {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    return navigateAndRead(cdp, sessionId);
  },
  'createTarget, no newWindow': async (cdp) => {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    return navigateAndRead(cdp, sessionId);
  },
  'createTarget newWindow + activateTarget': async (cdp) => {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Target.activateTarget', { targetId });
    return navigateAndRead(cdp, sessionId);
  },
  'createTarget newWindow, url given': async (cdp) => {
    const r = result();
    const { targetId } = await cdp.send('Target.createTarget', { url, newWindow: true });
    await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    return r;
  },
  // A startup window (about:blank on the command line), then its tab.
  'startup window tab': async (cdp) => {
    let page;
    for (let i = 0; i < 50 && !page; i++) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      page = targetInfos.find((t) => t.type === 'page');
      if (!page) await new Promise((r) => setTimeout(r, 100));
    }
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    return navigateAndRead(cdp, sessionId);
  },
};

for (const headless of [false, true]) {
  for (const [name, way] of Object.entries(WAYS)) {
    const profile = path.join(scratch, 'profiles', `window-${Date.now()}`);
    fs.mkdirSync(profile, { recursive: true });
    const startup = name === 'startup window tab';
    const switches = BASE_SWITCHES.filter((s) => !(startup && s === '--no-startup-window'));
    const cdp = launchPipe(exe, [
      `--user-data-dir=${profile}`,
      '--fingerprint-seed=12345',
      ...switches,
      ...headSwitches(headless),
      ...(startup ? ['about:blank'] : []),
    ]);
    try {
      const r = await way(cdp);
      console.log(`${headless ? 'headless' : 'headed  '} ${name.padEnd(40)} load ${JSON.stringify(r.atLoad)}  later ${JSON.stringify(r.later)}`);
    } catch (e) {
      console.log(`${headless ? 'headless' : 'headed  '} ${name.padEnd(40)} FAIL ${e.message}`);
    } finally {
      await cdp.send('Browser.close').catch(() => {});
      spawnSync('taskkill', ['/PID', String(cdp.proc.pid), '/T', '/F'], { stdio: 'ignore' });
    }
  }
}
server.close();
