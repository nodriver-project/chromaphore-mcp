// Phase 0 spike: launch over the pipe, open a tab, list it with the agent
// snapshot, evaluate without Runtime.enable (main world and an isolated
// world), read the fingerprint, close.
// Usage: node spike_pipe.mjs [--headed] [chrome.exe]
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EXE, BASE_SWITCHES, headSwitches, launchPipe, openTab } from './cdp_pipe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const headed = process.argv.includes('--headed');
const exe = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? DEFAULT_EXE;
const profile = path.resolve(here, '../../.scratch/profiles', `pipe-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });

const PAGE = `<!doctype html><title>pipe spike</title>
<h1>Pipe spike</h1>
<label>Name <input id="name"></label>
<button onclick="document.title='clicked'">Go</button>
<a href="#x">A link</a>
<script>window.appState = { ready: true, n: 42 };</script>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const t0 = Date.now();
const cdp = launchPipe(exe, [
  `--user-data-dir=${profile}`,
  '--fingerprint-seed=auto',
  ...BASE_SWITCHES,
  ...headSwitches(!headed),
]);
const step = async (name, fn) => {
  try {
    const out = await fn();
    console.log(`ok   ${name}${out === undefined ? '' : ': ' + out}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
  }
};

try {
  await step('Browser.getVersion', async () => {
    const v = await cdp.send('Browser.getVersion');
    return `${v.product} (${Date.now() - t0} ms after spawn)`;
  });
  const { sessionId } = await openTab(cdp, url);
  console.log(`ok   tab open and attached (${Date.now() - t0} ms)`);
  await step('Page.agentSettle', async () => {
    const r = await cdp.send('Page.agentSettle', {}, sessionId);
    return JSON.stringify(r.settle).slice(0, 160);
  });
  await step('Page.captureAgentSnapshot', async () => {
    const r = await cdp.send(
      'Page.captureAgentSnapshot',
      { includeScreenshot: false, scope: 'on' },
      sessionId,
    );
    const first = r.elements.slice(0, 4).map((e) => JSON.stringify(e)).join('\n       ');
    return `${r.elements.length} elements, listing ${r.listingId}\n       ${first}`;
  });
  await step('Runtime.evaluate, main world, no Runtime.enable', async () => {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression: 'JSON.stringify(window.appState)', returnByValue: true },
      sessionId,
    );
    return r.result.value;
  });
  await step('Page.createIsolatedWorld + Runtime.evaluate', async () => {
    const tree = await cdp.send('Page.getFrameTree', {}, sessionId);
    const { executionContextId } = await cdp.send(
      'Page.createIsolatedWorld',
      { frameId: tree.frameTree.frame.id, worldName: 'spike' },
      sessionId,
    );
    const r = await cdp.send(
      'Runtime.evaluate',
      {
        expression: 'typeof window.appState + " / " + document.title',
        contextId: executionContextId,
        returnByValue: true,
      },
      sessionId,
    );
    return r.result.value;
  });
  await step('Browser.getFingerprint', async () => {
    const f = (await cdp.send('Browser.getFingerprint')).fingerprint;
    return `headless=${f.headless} seed.master=${f.seed?.master} fonts.bundleActive=${f.fonts?.bundleActive}`;
  });
  await step('Browser.close', async () => {
    const exited = new Promise((r) => cdp.proc.once('exit', (code) => r(code)));
    await cdp.send('Browser.close').catch(() => {});
    return `exit code ${await exited}`;
  });
} finally {
  server.close();
  if (cdp.proc.exitCode === null) cdp.proc.kill();
  const prefs = path.join(profile, 'Default', 'Preferences');
  if (fs.existsSync(prefs)) {
    const p = JSON.parse(fs.readFileSync(prefs, 'utf8'));
    console.log(`profile exit_type: ${p.profile?.exit_type}`);
  }
}
