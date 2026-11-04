// browser_open with profile "temp": the profile is deleted after browser_close
// and after the session ends (stdin closed), and a stale temporary profile is
// swept by the next "temp" launch while a fresh one is left alone.
// Usage: node test/temp_profile.mjs [chrome.exe]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMP = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Chromeleon', 'temp');
const env = { ...process.env };
if (process.argv[2]) env.CHROMELEON_BROWSER = process.argv[2];
else delete env.CHROMELEON_BROWSER;

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gone(dir, ms) {
  const t0 = Date.now();
  while (fs.existsSync(dir) && Date.now() - t0 < ms) await sleep(250);
  return fs.existsSync(dir) ? null : Date.now() - t0;
}

async function connect() {
  const client = new Client({ name: 'temp-profile-test', version: '0' });
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
  return text;
}

const profileOf = (text) =>
  text.match(/Profile: (?:temporary, deleted when the browser closes \((.+)\)|(.+))\n/)?.slice(1).find(Boolean);

// A stale leftover and a fresh folder, as another server would have just made.
fs.mkdirSync(TEMP, { recursive: true });
const stale = path.join(TEMP, 'test-stale');
const fresh = path.join(TEMP, 'test-fresh');
for (const dir of [stale, fresh]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Local State'), '{}');
}
const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);

// 1. browser_close.
let client = await connect();
let text = await call(client, 'browser_open', {
  profile: 'temp',
  headless: true,
  url: 'data:text/html,<title>t</title><input aria-label=q>',
});
let profile = profileOf(text);
check(text.includes('Profile: temporary') && path.dirname(profile) === TEMP, `temp profile under ${TEMP}: ${profile}`);
check(fs.existsSync(path.join(profile, 'Local State')) || fs.existsSync(path.join(profile, 'Default')), 'the browser uses it');
check(!fs.existsSync(stale), 'the stale leftover was swept');
check(fs.existsSync(fresh), 'the fresh folder was left alone');
await call(client, 'type', { id: (text.match(/\b(a\d+)\b/) ?? [])[1] ?? 'a1', text: 'hello', exact: true });
text = await call(client, 'browser_close');
check(text.includes('temporary profile is deleted') && !fs.existsSync(profile), 'deleted by browser_close');

// 2. The session ends with the browser open.
text = await call(client, 'browser_open', { profile: 'temp', headless: true, url: 'about:blank' });
profile = profileOf(text);
check(fs.existsSync(profile), `second temp profile exists: ${profile}`);
await client.close();
let ms = await gone(profile, 70_000);
check(ms !== null, `deleted after the session ended (${ms} ms)`);

// 3. "new" still keeps its profile.
client = await connect();
text = await call(client, 'browser_open', { headless: true, url: 'about:blank' });
profile = profileOf(text);
await call(client, 'browser_close');
await client.close();
await sleep(3000);
check(!text.includes('temporary') && fs.existsSync(profile), `"new" profile kept: ${profile}`);
fs.rmSync(profile, { recursive: true, force: true });

fs.rmSync(fresh, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
