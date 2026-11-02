// Phase 0 spike: what a page can see of the driver. Loads
// tools/probe/automation_probe.html in five setups and compares the driven
// ones with the two baselines of the same headedness:
//   plain         a person's launch: profile and seed only, no other switch
//   baseline      the plugin's switches, no debugging switch, the probe given
//                 on the command line (what the connection alone adds)
//   pipe          --remote-debugging-pipe and the plugin's traffic
//   port          --remote-debugging-port=0 and the same traffic
//   pipe-runtime  the pipe, with Runtime.enable on the tab (as many CDP
//                 clients do)
// Usage: node spike_signals.mjs [--headed-only|--headless-only] [chrome.exe]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EXE, BASE_SWITCHES, headSwitches, plainHeadSwitches, launchPipe, launchPort } from './cdp_pipe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(here, 'automation_probe.html');
const SEED = '--fingerprint-seed=12345';
const WINDOW_MS = 8000;
const exe = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? DEFAULT_EXE;
const heads = process.argv.includes('--headed-only')
  ? [false]
  : process.argv.includes('--headless-only')
    ? [true]
    : [false, true];
const scratch = path.resolve(here, '../../.scratch');

let waiting = null;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/result') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.end('ok');
      waiting?.(JSON.parse(body));
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(fs.readFileSync(PROBE));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

function nextResult(timeoutMs) {
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no result')), timeoutMs);
    waiting = (r) => {
      clearTimeout(timer);
      waiting = null;
      resolve(r);
    };
  });
  p.catch(() => {});
  return p;
}

function freshProfile(label) {
  const p = path.join(scratch, 'profiles', `signals-${label}-${Date.now()}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const killTree = (pid) => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });

async function runBaseline(headless, label, plain = false) {
  const profile = freshProfile(label);
  const args = [
    `--user-data-dir=${profile}`,
    SEED,
    ...(plain ? plainHeadSwitches(headless) : [...BASE_SWITCHES.filter((s) => s !== '--no-startup-window'), ...headSwitches(headless)]),
    `${origin}/probe?mode=${label}&ms=${WINDOW_MS}`,
  ];
  const result = nextResult(WINDOW_MS + 20000);
  const proc = spawn(exe, args, { stdio: 'ignore' });
  try {
    return await result;
  } finally {
    killTree(proc.pid);
  }
}

// The plugin's traffic for one action round: navigate, settle, a listing with
// a screenshot, an evaluate, a human click on the button, a click into the
// field and typing.
async function drive(cdp, label, enableRuntime) {
  // The probe is the tab's first page, as in the baseline: every later
  // navigation's first script sees a 0x0 window in stock Chrome too
  // (spike_window2.mjs), which would hide what this compares.
  const result = nextResult(WINDOW_MS + 30000);
  const { targetId } = await cdp.send('Target.createTarget', {
    url: `${origin}/probe?mode=${label}&ms=${WINDOW_MS}`,
    newWindow: true,
  });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => cdp.send(m, p, sessionId);
  if (enableRuntime) await s('Runtime.enable');
  // The session answers "Not attached to an active page" for a moment after
  // a commit, until it has moved to the new document's frame host.
  for (let tries = 0; ; tries++) {
    try {
      await s('Page.agentSettle');
      break;
    } catch (e) {
      if (!/active page/.test(e.message) || tries >= 60) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const snap = await s('Page.captureAgentSnapshot', { scope: 'on' });
  await s('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  let pointer = { pointerX: snap.viewport.width / 2, pointerY: snap.viewport.height / 2 };
  const click = async (role) => {
    const el = snap.elements.find((e) => e.role === role && e.interactive);
    const node = await s('Page.resolveAgentNode', { agentNodeId: el.agentNodeId });
    const target = { backendNodeId: node.backendNodeId, frameId: node.localRootFrameId };
    const shown = await s('Input.revealElement', { ...target, ...pointer });
    if (shown.pointerX !== undefined) pointer = { pointerX: shown.pointerX, pointerY: shown.pointerY };
    const moved = await s('Input.moveTo', { ...target, ...pointer, end: { action: 'click' } });
    pointer = { pointerX: moved.x, pointerY: moved.y };
    return moved.outcome;
  };
  const outcomes = [await click('button'), await click('textbox')];
  const typed = await s('Input.dispatchKeystrokes', {
    text: 'hello world',
    keystrokeDelayMin: 60,
    keystrokeDelayMax: 260,
    readBack: true,
  });
  return { result: await result, outcomes, typedValue: typed.fieldAfter?.value };
}

async function runDriven(kind, headless, label) {
  const profile = freshProfile(label);
  const args = [`--user-data-dir=${profile}`, SEED, ...BASE_SWITCHES, ...headSwitches(headless)];
  const cdp = kind === 'port' ? await launchPort(exe, args, profile) : launchPipe(exe, args);
  try {
    const r = await drive(cdp, label, kind === 'pipe-runtime');
    r.result.driver = { outcomes: r.outcomes, typedValue: r.typedValue };
    return r.result;
  } finally {
    await cdp.send('Browser.close').catch(() => {});
    killTree(cdp.proc.pid);
  }
}

const results = {};
for (const headless of heads) {
  const head = headless ? 'headless' : 'headed';
  for (const kind of ['plain', 'baseline', 'pipe', 'port', 'pipe-runtime']) {
    const label = `${kind}-${head}`;
    process.stdout.write(`${label} ... `);
    try {
      results[label] =
        kind === 'plain'
          ? await runBaseline(headless, label, true)
          : kind === 'baseline'
            ? await runBaseline(headless, label)
            : await runDriven(kind, headless, label);
      console.log('ok');
    } catch (e) {
      console.log(`FAIL ${e.message}`);
    }
  }
}
server.close();

const outFile = path.join(scratch, `signals-${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(`\nfull results: ${outFile}`);

// Differences from each baseline of the same headedness: from "plain", what
// the plugin's whole launch shows; from "baseline", what the connection adds.
for (const head of heads.map((h) => (h ? 'headless' : 'headed')))
for (const baseKind of ['plain', 'baseline']) {
  const base = results[`${baseKind}-${head}`];
  if (!base) continue;
  console.log(`\n== ${head}: differences from ${baseKind}`);
  for (const kind of baseKind === 'plain' ? ['baseline', 'pipe', 'port', 'pipe-runtime'] : ['pipe', 'port', 'pipe-runtime']) {
    const r = results[`${kind}-${head}`];
    if (!r) continue;
    const diffs = [];
    for (const k of new Set([...Object.keys(base.checks), ...Object.keys(r.checks)])) {
      if (JSON.stringify(base.checks[k]) !== JSON.stringify(r.checks[k])) {
        diffs.push(`${k}: ${JSON.stringify(base.checks[k])} -> ${JSON.stringify(r.checks[k])}`);
      }
    }
    const traps = Object.keys(r.traps).length ? JSON.stringify(r.traps) : 'none fired';
    console.log(`-- ${kind}: ${diffs.length ? '' : 'no check differs'}`);
    for (const d of diffs) console.log(`   ${d}`);
    console.log(`   console traps: ${traps} (baseline: ${JSON.stringify(base.traps)})`);
    console.log(`   input: ${JSON.stringify(r.input)} driver: ${JSON.stringify(r.driver)}`);
    if (r.errors.length) console.log(`   errors: ${r.errors.join('; ')}`);
  }
}
