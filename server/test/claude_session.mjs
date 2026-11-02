// Loads the plugin into a real Claude Code session (claude -p --plugin-dir),
// asks it to open the browser on a local page and leave it open, then checks
// what the session's end did to the browser: it should have closed itself
// cleanly (profile exit_type Normal, no browser process left).
// Usage: node test/claude_session.mjs
// The browser comes from %LOCALAPPDATA%\Chromeleon\current.json, as after
// browser_install.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '../../plugin');

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>Session test</title><h1>Session test</h1><button>Hello</button>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${site.address().port}/`;

const prompt =
  `Use the chromeleon browser tools: open the browser headless at ${url}, then observe the page. ` +
  'Do not close the browser. Reply with the profile path from browser_open on a line starting "PROFILE:" ' +
  'and the button names you saw.';
const t0 = Date.now();
const out = await new Promise((resolve, reject) => {
  const p = spawn(
    'claude',
    ['-p', prompt, '--plugin-dir', pluginDir, '--allowedTools', 'mcp__plugin_chromeleon_browser__*', '--max-turns', '8'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let text = '';
  p.stdout.on('data', (c) => (text += c));
  p.on('error', reject);
  p.on('exit', (code) => resolve({ code, text }));
});
site.close();
console.log(`claude exited ${out.code} after ${Math.round((Date.now() - t0) / 1000)} s:\n${out.text.trim()}\n`);

const profile = /PROFILE:\s*(\S.*?)\s*$/m.exec(out.text)?.[1]?.replace(/[`*]/g, '');
if (!profile) throw new Error('no profile path in the answer');
await new Promise((r) => setTimeout(r, 3000));
const running = execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(profile)}*' } | Measure-Object).Count`,
  ],
  { encoding: 'utf8' },
).trim();
const prefs = JSON.parse(fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8'));
console.log(`browser processes left for that profile: ${running}`);
console.log(`profile exit_type: ${prefs.profile?.exit_type}`);
