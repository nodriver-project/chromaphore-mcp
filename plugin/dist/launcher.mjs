import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// src/launcher.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import path2 from "node:path";

// src/paths.ts
import os from "node:os";
import path from "node:path";
var DATA_ROOT = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "Chromeleon"
);
var PROFILES_DIR = path.join(DATA_ROOT, "profiles");
var TEMP_PROFILES_DIR = path.join(DATA_ROOT, "temp");
var BROWSERS_DIR = path.join(DATA_ROOT, "browser");
var CURRENT_FILE = path.join(DATA_ROOT, "current.json");

// src/launcher.ts
var argv = process.argv.slice(2);
if (argv[0] === "--reap") void reap(Number(argv[1]), argv[2]);
else launch(argv);
function launch(argv2) {
  let temp = null;
  if (argv2[0] === "--temp") {
    temp = argv2[1];
    argv2 = argv2.slice(2);
  }
  const [exe, ...args] = argv2;
  const child = spawn(exe, args, { stdio: ["ignore", "ignore", "ignore", 3, 4], detached: true });
  child.on("error", (e) => {
    process.stdout.write(`error ${e.message}
`, () => process.exit(1));
  });
  if (child.pid !== void 0) {
    child.unref();
    if (temp) {
      spawn(process.execPath, [process.argv[1], "--reap", String(child.pid), temp], {
        stdio: "ignore",
        detached: true,
        windowsHide: true
      }).unref();
    }
    process.stdout.write(`${child.pid}
`, () => process.exit(0));
  }
}
async function reap(pid, profile) {
  if (path2.dirname(path2.resolve(profile)) !== TEMP_PROFILES_DIR) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (alive(pid)) await sleep(500);
  for (let i = 0; i < 60; i++) {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
      return;
    } catch {
      await sleep(1e3);
    }
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
