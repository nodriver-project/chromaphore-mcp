// browser_install: the latest full build from the GitHub Releases page,
// checked against the SHA-256 GitHub publishes for every asset, unpacked
// under %LOCALAPPDATA%\Chromeleon\browser\<tag>.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ToolError } from './browser.js';
import { BROWSERS_DIR, CURRENT_FILE, DATA_ROOT, installedBrowser } from './paths.js';

const RELEASES = 'https://api.github.com/repos/nodriver-project/Chromeleon-Browser/releases/latest';

export type Progress = (done: number, total: number, message: string) => void;

interface Asset {
  name: string;
  size: number;
  digest?: string;
  browser_download_url: string;
}

// The portable zip, by the name every release gives it from Chromeleon 1.0.0
// on (the browser's docs/releases.md):
// Chromeleon-<release>-chromium<chromium>-windows-x64-portable.zip.
const PORTABLE_ZIP = /^Chromeleon-\d+\.\d+\.\d+-chromium[\d.]+-windows-x64-portable\.zip$/;

function pickZip(assets: Asset[]): Asset | undefined {
  return assets.find((a) => PORTABLE_ZIP.test(a.name));
}

export async function latestRelease(): Promise<{ tag: string; asset: Asset }> {
  const res = await fetch(RELEASES, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new ToolError(`GitHub answered ${res.status} for the latest release.`);
  const rel: any = await res.json();
  const asset = pickZip(rel.assets ?? []);
  if (!asset) {
    throw new ToolError(
      `The latest release (${rel.tag_name}) has no Chromeleon portable zip; releases before Chromeleon 1.0.0 ` +
        'are too old for this plugin.',
    );
  }
  return { tag: rel.tag_name, asset };
}

function findExe(dir: string, depth = 3): string | null {
  const direct = path.join(dir, 'chrome.exe');
  if (fs.existsSync(direct)) return direct;
  if (depth === 0) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findExe(path.join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} failed: ${err.trim()}`))));
  });
}

// What is installed, and what the latest release on GitHub is; downloads
// nothing. The install skill calls it first, so it asks about a download
// only when there would be one.
export async function checkInstall(): Promise<string> {
  const lines: string[] = [];
  const configured = process.env.CHROMELEON_BROWSER?.trim();
  if (configured && !configured.includes('${')) {
    const there = fs.existsSync(configured) ? '' : ' (that file does not exist)';
    lines.push(`The plugin settings name a browser of their own: ${configured}${there}. browser_open uses it, not an installed release.`);
  }
  const current = installedBrowser();
  const currentOk = current !== null && fs.existsSync(current.exe);
  if (current && currentOk) lines.push(`Installed: release ${current.tag} (${current.exe}).`);
  else if (current) lines.push(`The install record names release ${current.tag}, but its chrome.exe is gone (${current.exe}).`);
  else lines.push('No release is installed.');
  try {
    const { tag, asset } = await latestRelease();
    if (currentOk && current!.tag === tag) {
      lines.push(`That is the latest release on GitHub: browser_install would download nothing.`);
    } else {
      const replace = currentOk ? ` and replace ${current!.tag} (its folder is removed; profiles stay)` : '';
      lines.push(
        `The latest release on GitHub is ${tag}: browser_install would download ${asset.name} ` +
          `(${Math.round(asset.size / 1e6)} MB)${replace}.`,
      );
    }
  } catch (e) {
    lines.push(`GitHub could not be asked for the latest release: ${e instanceof Error ? e.message : String(e)}`);
  }
  return lines.join('\n');
}

export async function install(progress: Progress, signal: AbortSignal): Promise<string> {
  const { tag, asset } = await latestRelease();
  const current = installedBrowser();
  const dir = path.join(BROWSERS_DIR, tag);
  if (current?.tag === tag && fs.existsSync(current.exe)) return `Release ${tag} is already installed: ${current.exe}`;

  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const zip = path.join(DATA_ROOT, `${asset.name}.part`);
  const res = await fetch(asset.browser_download_url, { signal });
  if (!res.ok || !res.body) throw new ToolError(`The download answered ${res.status}.`);
  const total = Number(res.headers.get('content-length')) || asset.size;
  const hash = createHash('sha256');
  const out = fs.createWriteStream(zip);
  let done = 0;
  let lastReport = 0;
  for await (const chunk of Readable.fromWeb(res.body as any)) {
    hash.update(chunk);
    done += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (Date.now() - lastReport > 1000) {
      lastReport = Date.now();
      progress(done, total, `Downloading ${asset.name}: ${Math.round(done / 1e6)} of ${Math.round(total / 1e6)} MB`);
    }
  }
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));

  const sha = hash.digest('hex');
  if (asset.digest && asset.digest !== `sha256:${sha}`) {
    fs.rmSync(zip, { force: true });
    throw new ToolError(`The download's SHA-256 (${sha}) does not match the release's (${asset.digest}). Nothing was installed.`);
  }

  progress(total, total, 'Unpacking');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Windows' own tar reads zips, and is much faster than Expand-Archive over
  // the font bundle's thousands of files.
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  await run(tar, ['-xf', zip, '-C', dir]);
  fs.rmSync(zip, { force: true });

  const exe = findExe(dir);
  if (!exe) throw new ToolError(`No chrome.exe in the unpacked release under ${dir}.`);
  fs.writeFileSync(CURRENT_FILE, JSON.stringify({ tag, exe }, null, 2));
  if (current && current.tag !== tag) {
    const old = path.join(BROWSERS_DIR, current.tag);
    fs.rmSync(old, { recursive: true, force: true });
  }
  return `Installed release ${tag} (SHA-256 checked${asset.digest ? '' : ': none published, so not compared'}): ${exe}`;
}
