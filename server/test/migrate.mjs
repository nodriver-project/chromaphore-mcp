// Moving what plugin versions before 0.2.0 kept under %LOCALAPPDATA%\Chromeleon.
// With a browser running from the old release on one old profile, the
// server's start moves only the free profile, and the release keeps working
// where it is; a profile touched in the last ten minutes waits too. Once that
// browser has exited, the next start moves the release and the other
// profiles, and the old record points at the new place. Then: a start that
// finds the release moved but unrecorded records it, and a release folder on
// the removal list is deleted at the first start that finds it free.
// It runs on the real folders: it needs a release installed by an older
// plugin, none under the new name, and no browser running from the release.
// Usage: node test/migrate.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OLD = path.join(process.env.LOCALAPPDATA, 'Chromeleon');
const NEW = path.join(process.env.LOCALAPPDATA, 'Chromaphore');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env };
// Not the session this test runs in: its page count would carry over
// between runs (browser.ts, nextPageNumber).
delete env.CLAUDE_CODE_SESSION_ID;
delete env.CHROMAPHORE_BROWSER;

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

// Processes whose program lies in this folder.
function runningFrom(dir) {
  const prefix = `${dir}\\`.replace(/'/g, "''");
  return Number(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${prefix}', [StringComparison]::OrdinalIgnoreCase) }).Count`,
      ],
      { encoding: 'utf8' },
    ).trim(),
  );
}

async function connect() {
  const client = new Client({ name: 'migrate-test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(here, '../../plugin/dist/server.mjs')],
      env,
      stderr: 'inherit',
    }),
  );
  return client;
}

async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const text = r.content[0].text;
  console.log(`  ${name}: ${r.isError ? 'ERROR ' : ''}${text.split('\n').slice(0, 3).join(' | ')}`);
  return { text, isError: !!r.isError };
}

if (!fs.existsSync(path.join(OLD, 'current.json'))) throw new Error(`no release installed under ${OLD}`);
if (fs.existsSync(path.join(NEW, 'current.json'))) throw new Error(`a release is already recorded under ${NEW}`);
const old = read(path.join(OLD, 'current.json'));
const oldRelease = path.join(OLD, 'browser', old.tag);
if (runningFrom(oldRelease) > 0) throw new Error(`a browser is running from ${oldRelease}; close it first`);

// Three old profiles: one free, one just used, one a browser of the old
// release has open.
const free = path.join(OLD, 'profiles', 'test-migrate-free');
const recent = path.join(OLD, 'profiles', 'test-migrate-recent');
const busy = path.join(OLD, 'profiles', 'test-migrate-busy');
const anHourAgo = new Date(Date.now() - 3_600_000);
for (const dir of [free, recent]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'marker.txt'), path.basename(dir));
}
fs.utimesSync(free, anHourAgo, anHourAgo);
const browser = spawn(old.exe, ['--headless=new', `--user-data-dir=${busy}`, 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 40 && !fs.existsSync(path.join(busy, 'lockfile')); i++) await sleep(250);
check(fs.existsSync(path.join(busy, 'lockfile')), 'a browser of the old release has the busy profile open');
// Aged so that only its lockfile keeps it in place, though the running
// browser may touch the folder again before the server starts, in which case
// the ten-minute rule keeps it too; browser_open's refusal below checks the
// lockfile test itself.
fs.utimesSync(busy, anHourAgo, anHourAgo);

// 1. The first start, with that browser running.
let client = await connect();
check(!fs.existsSync(path.join(NEW, 'current.json')), 'the release in use was not moved');
check(fs.existsSync(oldRelease), `it is still at ${oldRelease}`);
check(fs.existsSync(path.join(NEW, 'profiles', 'test-migrate-free', 'marker.txt')) && !fs.existsSync(free), 'the free profile moved');
check(fs.existsSync(recent), 'the profile touched just now stayed');
check(fs.existsSync(busy), 'the busy profile stayed');
let r = await call(client, 'browser_install', { check_only: true });
check(r.text.includes(old.exe), 'browser_install reports the release where it is');
r = await call(client, 'browser_open', { profile: free, headless: true });
check(!r.isError && r.text.includes(`Profile: ${path.join(NEW, 'profiles', 'test-migrate-free')}`), 'the old path of the moved profile opens it');
await call(client, 'browser_close');
r = await call(client, 'browser_open', { profile: busy, headless: true });
check(r.isError && /open in another browser/.test(r.text), 'the busy profile is refused while open');
await client.close();

// 2. The browser exits; the next start moves the rest.
execFileSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
for (let i = 0; i < 40 && runningFrom(oldRelease) > 0; i++) await sleep(500);
check(runningFrom(oldRelease) === 0, 'no browser runs from the old release any more');
for (const dir of [recent, busy]) fs.utimesSync(dir, anHourAgo, anHourAgo);
client = await connect();
const moved = fs.existsSync(path.join(NEW, 'current.json')) ? read(path.join(NEW, 'current.json')) : null;
check(moved !== null && moved.tag === old.tag && fs.existsSync(moved.exe), `the release moved: ${moved?.exe}`);
check(moved !== null && path.dirname(moved.exe).startsWith(path.join(NEW, 'browser', old.tag)), 'into the new browser folder');
check(!fs.existsSync(oldRelease), 'the old release folder is gone');
check(read(path.join(OLD, 'current.json')).exe === moved?.exe, 'the old record points at the new place');
check(
  fs.existsSync(path.join(NEW, 'profiles', 'test-migrate-busy')) &&
    fs.existsSync(path.join(NEW, 'profiles', 'test-migrate-recent')) &&
    !fs.existsSync(path.join(OLD, 'profiles')),
  'the other two profiles moved, and the old profiles folder is gone',
);
r = await call(client, 'browser_install', { check_only: true });
check(moved !== null && r.text.includes(moved.exe), 'browser_install reports the moved release');
r = await call(client, 'browser_open', { profile: 'temp', headless: true });
check(!r.isError && r.text.startsWith('Browser open: Chromaphore'), 'the moved release launches');
await call(client, 'browser_close');
await client.close();

// 3. A start that moved the folder but did not get to write the records:
// the old record still names the old place, the new one is missing.
fs.rmSync(path.join(NEW, 'current.json'));
fs.writeFileSync(path.join(OLD, 'current.json'), JSON.stringify(old, null, 2));
client = await connect();
await client.close();
const rewritten = fs.existsSync(path.join(NEW, 'current.json')) ? read(path.join(NEW, 'current.json')) : null;
check(rewritten?.exe === moved?.exe && read(path.join(OLD, 'current.json')).exe === moved?.exe, 'the next start writes both records');

// 4. The removal list: a release folder with a file held open the way a
// running browser holds its .pak files (no delete sharing), then free; a
// renamed folder whose delete a server did not finish; a path outside the
// plugin's folders. The deletes run after the handshake, so each server is
// given a moment before it is closed.
const leftover = path.join(NEW, 'browser', 'test-leftover-removing');
fs.mkdirSync(path.join(leftover, 'fonts'), { recursive: true });
fs.writeFileSync(path.join(leftover, 'fonts', 'a.ttf'), 'x');
const held = path.join(NEW, 'browser', 'test-pending');
fs.mkdirSync(held, { recursive: true });
const pak = path.join(held, 'resources.pak');
fs.writeFileSync(pak, 'x');
const holder = spawn(
  'powershell.exe',
  ['-NoProfile', '-Command', `$f = [IO.File]::Open('${pak}', 'Open', 'Read', 'Read'); Start-Sleep 120; $f.Close()`],
  { stdio: 'ignore' },
);
await sleep(2500);
const list = path.join(NEW, 'remove.json');
fs.writeFileSync(list, JSON.stringify([held, leftover, 'C:\\Windows\\Temp\\not-a-release'], null, 2));
client = await connect();
await sleep(2000);
await client.close();
check(fs.existsSync(held) && JSON.stringify(read(list)) === JSON.stringify([held]), 'a folder still in use stays on the list (and a path outside the plugin is dropped)');
check(!fs.existsSync(leftover), 'an unfinished delete is finished');
execFileSync('taskkill', ['/PID', String(holder.pid), '/T', '/F'], { stdio: 'ignore' });
await sleep(1000);
client = await connect();
await sleep(2000);
await client.close();
check(!fs.existsSync(held) && !fs.existsSync(`${held}-removing`) && !fs.existsSync(list), 'once free, it is deleted and the list is gone');

for (const name of ['test-migrate-free', 'test-migrate-recent', 'test-migrate-busy']) {
  fs.rmSync(path.join(NEW, 'profiles', name), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
console.log(`left under ${OLD}: ${fs.existsSync(OLD) ? fs.readdirSync(OLD).join(', ') : '(folder gone)'}`);
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
