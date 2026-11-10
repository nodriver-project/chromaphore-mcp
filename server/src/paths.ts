// Where the plugin keeps the browser and its profiles. Not in Claude Code's
// plugin data folder: that one is deleted with the plugin, and profiles hold
// people's logins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
export const DATA_ROOT = path.join(LOCAL, 'Chromaphore');
export const PROFILES_DIR = path.join(DATA_ROOT, 'profiles');
// Temporary profiles, each deleted when its browser exits.
export const TEMP_PROFILES_DIR = path.join(DATA_ROOT, 'temp');
export const BROWSERS_DIR = path.join(DATA_ROOT, 'browser');
export const CURRENT_FILE = path.join(DATA_ROOT, 'current.json');
// Replaced releases whose folder was in use when browser_install replaced
// them, deleted at a later start.
const PENDING_FILE = path.join(DATA_ROOT, 'remove.json');

// The same layout under the plugin's name before 0.2.0, chromeleon.
const OLD_ROOT = path.join(LOCAL, 'Chromeleon');
const OLD_PROFILES_DIR = path.join(OLD_ROOT, 'profiles');
const OLD_BROWSERS_DIR = path.join(OLD_ROOT, 'browser');
export const OLD_TEMP_PROFILES_DIR = path.join(OLD_ROOT, 'temp');
export const OLD_CURRENT_FILE = path.join(OLD_ROOT, 'current.json');

export interface Installed {
  tag: string;
  exe: string;
  // The release's folder, removed when browser_install replaces it.
  dir: string;
}

// The browser to launch: the one the user named in the plugin's settings,
// else the one browser_install put in place, else none.
export function browserExe(): string | null {
  const configured = configuredBrowser();
  if (configured) return configured;
  const installed = installedBrowser();
  return installed && fs.existsSync(installed.exe) ? installed.exe : null;
}

export function configuredBrowser(): string | null {
  const configured = process.env.CHROMAPHORE_BROWSER?.trim();
  // An unset user_config option may arrive as an empty string or as the
  // placeholder itself.
  return configured && !configured.includes('${') ? configured : null;
}

// A release tag as GitHub gives it (v1.0.0): one folder name, never "",
// "." or "..", which would make a release folder of the data folder itself.
export const isTag = (tag: unknown): tag is string => typeof tag === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag);

function readRecord(file: string): { tag: string; exe: string } | null {
  try {
    const { tag, exe } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isTag(tag) && typeof exe === 'string' ? { tag, exe } : null;
  } catch {
    return null;
  }
}

// The installed release; one installed before 0.2.0 that could not be moved
// yet (moveFromChromeleon) is used where it is.
export function installedBrowser(): Installed | null {
  for (const file of [CURRENT_FILE, OLD_CURRENT_FILE]) {
    const record = readRecord(file);
    if (record) return { ...record, dir: releaseDir(record.exe, record.tag) };
  }
  return null;
}

// The <root>\browser\<tag> folder that holds this chrome.exe.
function releaseDir(exe: string, tag: string): string {
  for (let dir = path.dirname(exe); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (path.basename(dir) === tag && path.basename(path.dirname(dir)).toLowerCase() === 'browser') return dir;
  }
  return path.join(BROWSERS_DIR, tag);
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function newProfileDir(temp = false): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dir = path.join(temp ? TEMP_PROFILES_DIR : PROFILES_DIR, `${stamp}-${Math.random().toString(16).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function profileInUse(profile: string): boolean {
  // A running browser holds its profile's lockfile open; a stale one can go.
  const lock = path.join(profile, 'lockfile');
  if (!fs.existsSync(lock)) return false;
  try {
    fs.rmSync(lock);
    return false;
  } catch {
    return true;
  }
}

// Deletes a release folder without breaking a browser still running from it,
// here or in another session. A running browser keeps files of its release
// open, so Windows refuses to rename the folder (EBUSY, measured 2026-11-09),
// yet it would delete the files that are not open. So the folder is renamed
// first and deleted only once that worked. (A program that keeps no file of
// its folder open, such as a copied ping.exe, does not stop the rename, and
// neither does a browser in its first moments, before it has opened them.)
// A folder that cannot go now is kept on a list and deleted at a later
// start; so is a renamed one until its delete has finished, should the
// server end in the middle of it. The deletes are asynchronous: a release
// holds thousands of font files and takes seconds.
export async function removeRelease(dir: string): Promise<'removed' | 'kept'> {
  const doomed = `${dir}-removing`;
  try {
    await fs.promises.rm(doomed, { recursive: true, force: true });
    fs.renameSync(dir, doomed);
  } catch {
    if (fs.existsSync(dir)) {
      addPending(dir);
      return 'kept';
    }
    dropPending(dir);
    return 'removed';
  }
  dropPending(dir);
  addPending(doomed);
  try {
    await fs.promises.rm(doomed, { recursive: true, force: true });
    dropPending(doomed);
  } catch {
    // Stays on the list: a later start tries again.
  }
  return 'removed';
}

function pending(): string[] {
  try {
    const list = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    // Only ever a release folder of the plugin's own.
    return Array.isArray(list)
      ? list.filter(
          (d): d is string =>
            typeof d === 'string' &&
            [BROWSERS_DIR, OLD_BROWSERS_DIR].some((parent) => samePath(path.dirname(d), parent)),
        )
      : [];
  } catch {
    return [];
  }
}

function setPending(list: string[]): void {
  if (list.length === 0) fs.rmSync(PENDING_FILE, { force: true });
  else fs.writeFileSync(PENDING_FILE, JSON.stringify(list, null, 2));
}

function addPending(dir: string): void {
  setPending([...pending().filter((d) => !samePath(d, dir)), dir]);
}

function dropPending(dir: string): void {
  const list = pending();
  if (list.some((d) => samePath(d, dir))) setPending(list.filter((d) => !samePath(d, dir)));
}

// The releases browser_install could not delete when it replaced them, and
// deletes a server ended in the middle of. Runs after every start of the
// server, without holding up its tools.
export async function removePendingReleases(): Promise<void> {
  const list = pending();
  if (list.length === 0) return;
  const current = installedBrowser();
  for (const dir of list) {
    // Never the release in use, should it have been installed again.
    if (current && samePath(dir, current.dir)) {
      dropPending(dir);
    } else if (!fs.existsSync(dir)) {
      dropPending(dir);
    } else if (dir.endsWith('-removing')) {
      // Renamed already: nothing runs from it.
      await fs.promises.rm(dir, { recursive: true, force: true }).then(
        () => dropPending(dir),
        () => {},
      );
    } else {
      await removeRelease(dir);
    }
  }
  removeOldRootIfEmpty();
}

// Moves what a version before 0.2.0 kept under %LOCALAPPDATA%\Chromeleon to
// the new folder: the installed release and the profiles, each on its own and
// only when no browser has it open, so a later start moves the rest. Runs at
// every start of the server.
export function moveFromChromeleon(): void {
  moveOldRelease();
  moveOldProfiles();
  removeOldRootIfEmpty();
}

function moveOldRelease(): void {
  const old = readRecord(OLD_CURRENT_FILE);
  if (!old) return;
  // Moved already, or a release installed under the new name.
  const current = readRecord(CURRENT_FILE);
  if (current && fs.existsSync(current.exe)) return;
  const from = path.join(OLD_BROWSERS_DIR, old.tag);
  const to = path.join(BROWSERS_DIR, old.tag);
  // The old record of a release moved before points into the new folder.
  const inside = path.relative(from, old.exe);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return;
  if (fs.existsSync(from)) {
    if (fs.existsSync(to)) return;
    try {
      fs.mkdirSync(BROWSERS_DIR, { recursive: true });
      // Refused (EBUSY) while a browser runs from the folder, which holds
      // files of it open (removeRelease): the release is used where it is,
      // and a later start moves it.
      fs.renameSync(from, to);
    } catch {
      return;
    }
  } else if (!fs.existsSync(path.join(to, inside))) {
    return;
  }
  // Also reached when an earlier start moved the folder but did not get to
  // write the records.
  const record = JSON.stringify({ tag: old.tag, exe: path.join(to, inside) }, null, 2);
  fs.writeFileSync(CURRENT_FILE, record);
  // The old record points at the new place too, for a server of the old
  // plugin still running in another session. An install of a newer release
  // removes it.
  fs.writeFileSync(OLD_CURRENT_FILE, record);
}

function moveOldProfiles(): void {
  let names: string[];
  try {
    names = fs.readdirSync(OLD_PROFILES_DIR);
  } catch {
    return;
  }
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  for (const name of names) {
    const from = path.join(OLD_PROFILES_DIR, name);
    const to = path.join(PROFILES_DIR, name);
    try {
      const stat = fs.statSync(from);
      // Touched in the last ten minutes: perhaps a browser is just starting
      // on it, before it has taken the lockfile. A later start moves it.
      if (fs.existsSync(to) || !stat.isDirectory() || Date.now() - stat.mtimeMs < 600_000) continue;
      if (profileInUse(from)) continue;
      fs.renameSync(from, to);
    } catch {
      // Held open after all: a later start moves it.
    }
  }
}

// A profile path a version before 0.2.0 returned, for a profile that has
// since moved: its new place.
export function movedProfile(profile: string): string {
  if (fs.existsSync(profile) || !samePath(path.dirname(profile), OLD_PROFILES_DIR)) return profile;
  const moved = path.join(PROFILES_DIR, path.basename(profile));
  return fs.existsSync(moved) ? moved : profile;
}

// Removes the old folder's empty parts, and the folder once it is empty.
export function removeOldRootIfEmpty(): void {
  for (const dir of [OLD_PROFILES_DIR, OLD_TEMP_PROFILES_DIR, OLD_BROWSERS_DIR, OLD_ROOT]) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Not empty, or not there.
    }
  }
}
