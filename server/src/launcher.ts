// Starts the browser detached, with this process's file descriptors 3 and 4
// (the pipe to the server) as its own 3 and 4, prints its pid and exits. The
// browser's parent is then gone, so neither Node's tie between a process and
// its children nor Claude Code's kill of the server's process tree reaches
// it: when the server ends, the pipe closes and the browser closes itself.
// Usage: node launcher.mjs [--temp <profile>] <chrome.exe> <args...>
//
// With --temp, it also starts a second detached copy of itself (--reap <pid>
// <profile>) that waits for the browser to exit, however it ends, and then
// deletes the temporary profile.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TEMP_PROFILES_DIR } from './paths.js';

const argv = process.argv.slice(2);
if (argv[0] === '--reap') void reap(Number(argv[1]), argv[2]);
else launch(argv);

function launch(argv: string[]): void {
  let temp: string | null = null;
  if (argv[0] === '--temp') {
    temp = argv[1];
    argv = argv.slice(2);
  }
  const [exe, ...args] = argv;
  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'ignore', 3, 4], detached: true });
  child.on('error', (e) => {
    process.stdout.write(`error ${e.message}\n`, () => process.exit(1));
  });
  if (child.pid !== undefined) {
    child.unref();
    if (temp) {
      spawn(process.execPath, [process.argv[1], '--reap', String(child.pid), temp], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      }).unref();
    }
    process.stdout.write(`${child.pid}\n`, () => process.exit(0));
  }
}

async function reap(pid: number, profile: string): Promise<void> {
  // Only ever a folder the server made for a temporary profile.
  if (path.dirname(path.resolve(profile)) !== TEMP_PROFILES_DIR) return;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (alive(pid)) await sleep(500);
  // The browser's helper processes (GPU, crash handler) can hold files in the
  // profile for a moment after it exits.
  for (let i = 0; i < 60; i++) {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
      return;
    } catch {
      await sleep(1000);
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
