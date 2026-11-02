// Starts the browser detached with this process's file descriptors 3 and 4
// (the pipe to the server) as its own 3 and 4, prints its pid, and exits, so
// the browser's parent is gone and a kill of the server's process tree does
// not reach it.
// Usage: node outside_launcher.mjs <chrome.exe> <args...>
import { spawn } from 'node:child_process';

const [exe, ...args] = process.argv.slice(2);
const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'ignore', 3, 4], detached: true });
child.unref();
process.stdout.write(`${child.pid}\n`, () => process.exit(0));
