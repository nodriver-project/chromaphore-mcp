// Where the plugin keeps the browser and its profiles. Not in Claude Code's
// plugin data folder: that one is deleted with the plugin, and profiles hold
// people's logins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA_ROOT = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'Chromeleon',
);
export const PROFILES_DIR = path.join(DATA_ROOT, 'profiles');
// Temporary profiles, each deleted when its browser exits.
export const TEMP_PROFILES_DIR = path.join(DATA_ROOT, 'temp');
export const BROWSERS_DIR = path.join(DATA_ROOT, 'browser');
export const CURRENT_FILE = path.join(DATA_ROOT, 'current.json');

export interface Installed {
  tag: string;
  exe: string;
}

// The browser to launch: the one the user named in the plugin's settings,
// else the one browser_install put in place, else none.
export function browserExe(): string | null {
  const configured = process.env.CHROMELEON_BROWSER?.trim();
  // An unset user_config option may arrive as an empty string or as the
  // placeholder itself.
  if (configured && !configured.includes('${')) return configured;
  const installed = installedBrowser();
  return installed && fs.existsSync(installed.exe) ? installed.exe : null;
}

export function installedBrowser(): Installed | null {
  try {
    return JSON.parse(fs.readFileSync(CURRENT_FILE, 'utf8')) as Installed;
  } catch {
    return null;
  }
}

export function newProfileDir(temp = false): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dir = path.join(temp ? TEMP_PROFILES_DIR : PROFILES_DIR, `${stamp}-${Math.random().toString(16).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
