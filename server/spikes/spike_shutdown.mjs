// Phase 0 spike: what Claude Code's shutdown of an MCP server does to the
// browser it launched. Claude Code on Windows closes the server's stdin, then
// kills the server's process tree 300 ms later; this does the same with
// taskkill /T /F and reports whether the browser was killed or closed itself,
// and the profile's exit_type (Normal after a clean close).
// Usage: node spike_shutdown.mjs [mode...]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, '../../.scratch');
const modes = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['child', 'child-close', 'detached-close', 'outside', 'outside-close'];

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const mode of modes) {
  const profile = path.join(scratch, 'profiles', `shutdown-${mode}-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const server = spawn(process.execPath, [path.join(here, 'shutdown_server.mjs'), mode, profile], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const browserPid = await new Promise((resolve, reject) => {
    let out = '';
    server.stdout.on('data', (c) => {
      out += c;
      const m = out.match(/ready (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    server.on('exit', () => reject(new Error('server exited early')));
  });
  await sleep(2000);
  server.stdin.end();
  await sleep(300);
  spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  const killedAt = Date.now();
  let goneAfter = null;
  while (Date.now() - killedAt < 15000) {
    if (!alive(browserPid)) {
      goneAfter = Date.now() - killedAt;
      break;
    }
    await sleep(50);
  }
  if (goneAfter === null) spawnSync('taskkill', ['/PID', String(browserPid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(500);
  let exitType = '(no Preferences)';
  try {
    exitType = JSON.parse(fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8')).profile?.exit_type;
  } catch {}
  console.log(
    `${mode.padEnd(15)} browser ${goneAfter === null ? 'still running after 15 s' : `gone ${goneAfter} ms after the kill`}; exit_type ${exitType}`,
  );
}
