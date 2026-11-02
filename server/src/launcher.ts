// Starts the browser detached, with this process's file descriptors 3 and 4
// (the pipe to the server) as its own 3 and 4, prints its pid and exits. The
// browser's parent is then gone, so neither Node's tie between a process and
// its children nor Claude Code's kill of the server's process tree reaches
// it: when the server ends, the pipe closes and the browser closes itself.
// Usage: node launcher.mjs <chrome.exe> <args...>
import { spawn } from 'node:child_process';

const [exe, ...args] = process.argv.slice(2);
const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'ignore', 3, 4], detached: true });
child.on('error', (e) => {
  process.stdout.write(`error ${e.message}\n`, () => process.exit(1));
});
if (child.pid !== undefined) {
  child.unref();
  process.stdout.write(`${child.pid}\n`, () => process.exit(0));
}
