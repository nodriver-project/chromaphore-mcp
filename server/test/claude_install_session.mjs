// The first-use flow in a real Claude Code session: the plugin loaded with
// --plugin-dir, the model asked to install the browser from the latest GitHub
// release, open a page and close it. Then checks what landed on disk: the
// installed release, its chrome.exe, the previous release's folder gone, no
// browser left running.
// Usage: node test/claude_install_session.mjs
// Downloads about 1.6 GB.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '../../plugin');
const root = path.join(process.env.LOCALAPPDATA, 'Chromeleon');
const currentFile = path.join(root, 'current.json');
const before = fs.existsSync(currentFile) ? JSON.parse(fs.readFileSync(currentFile, 'utf8')) : null;
console.log(`installed before: ${before ? before.tag : 'nothing'}`);

const prompt =
  'I agree to the browser download (about 1.6 GB). Using the chromeleon browser tools: call browser_install, ' +
  'then browser_open with headless true and url https://example.com, then browser_close. Reply with ' +
  "browser_install's answer verbatim, the browser version browser_open reported, and the page's main heading.";
const t0 = Date.now();
const out = await new Promise((resolve, reject) => {
  const p = spawn(
    'claude',
    ['-p', prompt, '--plugin-dir', pluginDir, '--allowedTools', 'mcp__plugin_chromeleon_browser__*', '--max-turns', '10'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let text = '';
  p.stdout.on('data', (c) => (text += c));
  p.on('error', reject);
  p.on('exit', (code) => resolve({ code, text }));
});
console.log(`claude exited ${out.code} after ${Math.round((Date.now() - t0) / 1000)} s:\n${out.text.trim()}\n`);

const after = fs.existsSync(currentFile) ? JSON.parse(fs.readFileSync(currentFile, 'utf8')) : null;
console.log(`installed after: ${after ? `${after.tag} (${after.exe})` : 'nothing'}`);
console.log(`chrome.exe there: ${after ? fs.existsSync(after.exe) : false}`);
if (before && after && before.tag !== after.tag) {
  console.log(`previous release folder removed: ${!fs.existsSync(path.join(root, 'browser', before.tag))}`);
}
console.log(`release folders now: ${fs.readdirSync(path.join(root, 'browser')).join(', ')}`);
const running = execFileSync(
  'powershell',
  ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*Chromeleon\\profiles*' } | Measure-Object).Count`],
  { encoding: 'utf8' },
).trim();
console.log(`browser processes left: ${running}`);
