// A minimal CDP client over --remote-debugging-pipe: the browser reads
// commands from its file descriptor 3 and writes answers and events to 4, each
// message one JSON text ended by a NUL byte. Node built-ins only.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// The browser the spikes run when none is named: CHROMAPHORE_BROWSER, else the
// one browser_install put in place (under the plugin's name before 0.2.0 too).
function defaultExe() {
  if (process.env.CHROMAPHORE_BROWSER) return process.env.CHROMAPHORE_BROWSER;
  for (const name of ['Chromaphore', 'Chromeleon']) {
    const current = `${process.env.LOCALAPPDATA}\\${name}\\current.json`;
    if (existsSync(current)) return JSON.parse(readFileSync(current, 'utf8')).exe;
  }
  return undefined;
}
export const DEFAULT_EXE = defaultExe();

// The switches the plugin always passes, besides the pipe (keep in step with
// server/src/browser.ts BASE_SWITCHES).
export const BASE_SWITCHES = [
  '--no-startup-window',
  '--disable-hang-monitor',
  '--auto-decline-webauthn',
  '--dismiss-permission-prompts',
  '--cancel-print-preview',
  '--cancel-payment-request',
  '--private-clipboard',
  '--disable-auto-reload',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  '--disable-features=Prerender2,UseEcoQoSForBackgroundProcess,AvoidUnnecessaryBeforeUnloadCheckSync',
];

export function headSwitches(headless) {
  return headless
    ? ['--headless=new', '--mute-audio', '--enable-gpu', '--fingerprint-screen=auto', '--fingerprint-screen-position=auto']
    : ['--show-cdp-cursor'];
}

// A person's launch: the headless switch only when headless, nothing else.
export function plainHeadSwitches(headless) {
  return headless ? ['--headless=new'] : [];
}

// Starts the browser with the pipe and returns a client. `args` must include
// --user-data-dir. The browser's stderr is kept (last 200 lines) for errors.
export function launchPipe(exe, args, spawnOptions = {}) {
  const proc = spawn(exe, ['--remote-debugging-pipe', ...args], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    ...spawnOptions,
  });
  return attachPipe(proc, proc.stdio[3], proc.stdio[4], proc.stdio[2]);
}

export function attachPipe(proc, toBrowser, fromBrowser, stderr) {
  const core = createCore(proc, (text) => toBrowser.write(text + '\0'), () => toBrowser.end(), stderr);
  let chunks = [];
  fromBrowser.on('data', (chunk) => {
    let start = 0;
    for (let i = chunk.indexOf(0); i !== -1; i = chunk.indexOf(0, start)) {
      chunks.push(chunk.subarray(start, i));
      const text = Buffer.concat(chunks).toString('utf8');
      chunks = [];
      start = i + 1;
      core.dispatch(JSON.parse(text));
    }
    if (start < chunk.length) chunks.push(chunk.subarray(start));
  });
  fromBrowser.on('end', () => core.onClose('end'));
  fromBrowser.on('error', (e) => core.onClose(e.message));
  toBrowser.on('error', (e) => core.onClose(e.message));
  return core.client;
}

// The same client over --remote-debugging-port=0: the port and the browser's
// WebSocket path are read from DevToolsActivePort in the profile.
export async function launchPort(exe, args, profile, spawnOptions = {}) {
  const proc = spawn(exe, ['--remote-debugging-port=0', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    ...spawnOptions,
  });
  const file = `${profile}\\DevToolsActivePort`;
  const { readFileSync, existsSync } = await import('node:fs');
  const deadline = Date.now() + 15000;
  const read = () => {
    try {
      return existsSync(file) ? readFileSync(file, 'utf8') : '';
    } catch {
      return ''; // still being written
    }
  };
  while (read().trim().split('\n').length < 2) {
    if (Date.now() > deadline) throw new Error('no DevToolsActivePort');
    await new Promise((r) => setTimeout(r, 50));
  }
  const [port, wsPath] = read().trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath.trim()}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WebSocket failed'));
  });
  const core = createCore(proc, (text) => ws.send(text), () => ws.close(), proc.stdio[2]);
  ws.onmessage = (e) => core.dispatch(JSON.parse(e.data));
  ws.onclose = () => core.onClose('socket closed');
  return core.client;
}

function createCore(proc, write, closeWrite, stderr) {
  const pending = new Map();
  const listeners = new Set();
  const stderrTail = [];
  let nextId = 1;
  let closed = false;

  stderr?.setEncoding('utf8');
  stderr?.on('data', (text) => {
    for (const line of text.split(/\r?\n/)) {
      if (line) stderrTail.push(line);
    }
    if (stderrTail.length > 200) stderrTail.splice(0, stderrTail.length - 200);
  });

  const onClose = (why) => {
    if (closed) return;
    closed = true;
    for (const { reject } of pending.values()) reject(new Error(`connection closed (${why})`));
    pending.clear();
    for (const l of listeners) l({ method: '__closed', params: { why } });
  };

  function dispatch(msg) {
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) {
        const e = new Error(`${p.method}: ${msg.error.message}`);
        e.cdp = msg.error;
        p.reject(e);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    for (const l of listeners) l(msg);
  }

  function send(method, params = {}, sessionId) {
    if (closed) return Promise.reject(new Error('pipe closed'));
    const id = nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      write(JSON.stringify(msg));
    });
  }

  function on(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // Resolves with the first event matching `method` (and `sessionId`, when
  // given) or rejects after `timeoutMs`.
  function waitFor(method, sessionId, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`no ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      const off = on((msg) => {
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
          clearTimeout(timer);
          off();
          resolve(msg.params);
        }
      });
    });
  }

  return {
    dispatch,
    onClose,
    client: {
      proc,
      send,
      on,
      waitFor,
      closePipe: closeWrite,
      stderrTail,
      get closed() {
        return closed;
      },
    },
  };
}

// Opens a tab and attaches a flat session to it.
export async function openTab(cdp, url = 'about:blank') {
  const { targetId } = await cdp.send('Target.createTarget', { url, newWindow: true });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return { targetId, sessionId };
}
