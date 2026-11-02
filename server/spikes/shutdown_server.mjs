// Stands in for the MCP server in spike_shutdown.mjs: launches the browser
// one way, opens a tab, prints "ready <browser pid> <profile>", then waits
// for its stdin to close, as Claude Code closes it at the end of a session.
// Usage: node shutdown_server.mjs <mode> <profile>
//   child           the browser as an ordinary child; nothing on stdin close
//   child-close     an ordinary child; Browser.close on stdin close
//   detached-close  detached (libuv does not tie it to this process), still
//                   this process's child; Browser.close on stdin close
//   outside         started through a launcher process that exits, so it is
//                   detached and outside this process's tree; nothing on
//                   stdin close (the pipe closing when this process dies is
//                   what ends it)
//   outside-close   the same, with Browser.close on stdin close
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EXE, BASE_SWITCHES, headSwitches, attachPipe, openTab } from './cdp_pipe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [mode, profile] = process.argv.slice(2);
const args = [
  '--remote-debugging-pipe',
  `--user-data-dir=${profile}`,
  '--fingerprint-seed=12345',
  ...BASE_SWITCHES,
  ...headSwitches(false),
];

let proc;
let browserPid;
if (mode.startsWith('outside')) {
  proc = spawn(process.execPath, [path.join(here, 'outside_launcher.mjs'), DEFAULT_EXE, ...args], {
    stdio: ['ignore', 'pipe', 'ignore', 'pipe', 'pipe'],
    detached: true,
  });
  browserPid = await new Promise((resolve) => {
    let out = '';
    proc.stdout.on('data', (c) => {
      out += c;
      if (out.includes('\n')) resolve(Number(out.trim()));
    });
  });
} else {
  proc = spawn(DEFAULT_EXE, args, {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    detached: mode === 'detached-close',
  });
  browserPid = proc.pid;
}
const cdp = attachPipe(proc, proc.stdio[3], proc.stdio[4], null);
await openTab(cdp, 'about:blank');
console.log(`ready ${browserPid} ${profile}`);

process.stdin.resume();
process.stdin.on('end', () => {
  if (mode.endsWith('-close')) cdp.send('Browser.close').catch(() => {});
});
