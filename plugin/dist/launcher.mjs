import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// src/launcher.ts
import { spawn } from "node:child_process";
var [exe, ...args] = process.argv.slice(2);
var child = spawn(exe, args, { stdio: ["ignore", "ignore", "ignore", 3, 4], detached: true });
child.on("error", (e) => {
  process.stdout.write(`error ${e.message}
`, () => process.exit(1));
});
if (child.pid !== void 0) {
  child.unref();
  process.stdout.write(`${child.pid}
`, () => process.exit(0));
}
