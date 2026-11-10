// One browser process and its tabs. Each tab gets one flat CDP session for
// its whole life: the custom commands keep per-session state (the pointer,
// the settle arm), and the humanized Input commands run only on the tab's own
// session.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpError, Connection, type CdpEvent } from './cdp.js';
import {
  browserExe,
  movedProfile,
  newProfileDir,
  OLD_TEMP_PROFILES_DIR,
  profileInUse,
  removeOldRootIfEmpty,
  TEMP_PROFILES_DIR,
} from './paths.js';

export class ToolError extends Error {}

// The first release with every command the tools use (the round-2 protocol).
const MIN_MAJOR = 156;

export interface OpenOptions {
  profile?: string;
  seed?: number;
  headless?: boolean;
}

// The switches the plugin always passes for an unattended browser
// (docs/DESIGN.md, "Launch switches"). The browser's own preset already adds
// first-run, telemetry and background-traffic switches and
// --hide-crash-restore-bubble. Never --disable-ipc-flooding-protection: a
// page can count the history.replaceState() calls that go through, and
// Chrome stops at 200.
const BASE_SWITCHES = [
  '--remote-debugging-pipe',
  '--no-startup-window',
  '--disable-hang-monitor',
  // Prompts nobody at the window can answer: WebAuthn declined, permission
  // bubbles dismissed (nothing remembered), print previews and payment sheets
  // cancelled as a person would.
  '--auto-decline-webauthn',
  '--dismiss-permission-prompts',
  '--cancel-print-preview',
  '--cancel-payment-request',
  // A clipboard of its own: the machine's is the user's.
  '--private-clipboard',
  // A network-error page stays as it is instead of reloading itself unseen.
  '--disable-auto-reload',
  // Tabs the agent is not looking at keep running at full speed.
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  // Merged by the browser with its preset's list (which disables AimEnabled
  // itself from release 1.0.0 on). Prerender2: no hidden prerendered pages
  // or extra targets under the agent. UseEcoQoSForBackgroundProcess:
  // background tabs off Windows' efficiency mode.
  '--disable-features=Prerender2,UseEcoQoSForBackgroundProcess,AvoidUnnecessaryBeforeUnloadCheckSync',
];

export interface Dialog {
  type: string;
  message: string;
  defaultPrompt?: string;
}

export class Tab {
  pointer: { x: number; y: number } | null = null;
  viewport: { width: number; height: number } | null = null;
  lastListingId: string | null = null;
  // The letters of the page the tab's last listing showed (Browser.lettersFor).
  letters = 'a';
  // When the main frame's latest cross-document load started, while it has
  // neither committed nor failed; 0 for none (navigationPending).
  private navigationStartedAt = 0;
  // Actions whose load has been told to have ended: a late event can be
  // handled before the answer that told its start (the answer's
  // continuation runs after the pipe's read is dispatched).
  private readonly loadEnded = new Set<number>();
  dialog: Dialog | null = null;
  notices: string[] = [];
  closed = false;
  private dialogWaiters: (() => void)[] = [];

  constructor(
    readonly browser: Browser,
    readonly id: string,
    readonly targetId: string,
    readonly sessionId: string,
  ) {}

  async send<T = any>(method: string, params: object = {}, timeoutMs?: number): Promise<T> {
    const r: any = await this.browser.conn.send<T>(method, params, this.sessionId, timeoutMs);
    // What an input action led to, from every command that answers with it,
    // a press of several or the select-all before typing included.
    const outcome = r?.actionOutcome;
    for (const ev of outcome?.events ?? []) this.noteEvent(ev, outcome.actionId);
    return r;
  }

  takeNotices(): string[] {
    const n = this.notices;
    this.notices = [];
    return n;
  }

  // Follows the main frame's cross-document loads in what the browser says an
  // action led to (Input.actionOutcome's event, an action's answer).
  noteEvent(ev: any, actionId?: number): void {
    if (ev?.kind !== 'navigation' || ev.mainFrame === false || ev.sameDocument) return;
    if (ev.state === 'started') {
      if (actionId === undefined || !this.loadEnded.has(actionId)) this.navigationStartedAt = Date.now();
    } else if (ev.state === 'committed' || ev.state === 'failed') {
      this.navigationStartedAt = 0;
      if (actionId !== undefined) {
        this.loadEnded.add(actionId);
        if (this.loadEnded.size > 64) this.loadEnded.delete(this.loadEnded.values().next().value!);
      }
    }
  }

  // The agent's own navigation replaces a load an action started, whose end
  // then never comes.
  navigationReplaced(): void {
    this.navigationStartedAt = 0;
  }

  // A load started and not yet landed: the ids listed will be gone when it
  // does. One whose end was never told stops counting after 30 s.
  navigationPending(): boolean {
    return this.navigationStartedAt !== 0 && Date.now() - this.navigationStartedAt < 30_000;
  }

  dialogOpened(d: Dialog): void {
    this.dialog = d;
    const waiters = this.dialogWaiters;
    this.dialogWaiters = [];
    for (const w of waiters) w();
  }

  // Resolves with `work`'s result, or with 'dialog' as soon as a JavaScript
  // dialog opens: the page then answers nothing until it is answered, so a
  // settle or a capture would only time out.
  untilDialog<T>(work: Promise<T>): Promise<T | 'dialog'> {
    if (this.dialog) {
      work.catch(() => {});
      return Promise.resolve('dialog');
    }
    const opened = new Promise<'dialog'>((resolve) => this.dialogWaiters.push(() => resolve('dialog')));
    work.catch(() => {});
    return Promise.race([work, opened]);
  }
}

export class Browser {
  // Names this browser in the page registry (pageOf) without keeping it alive.
  readonly serial = ++browsersOpened;
  readonly tabs = new Map<string, Tab>(); // by targetId
  private readonly tabIds = new Map<string, string>(); // targetId -> t1, t2, ...
  private readonly targets = new Map<string, { url: string; title: string; type: string }>();
  private tabCounter = 0;
  activeTargetId: string | null = null;
  notices: string[] = [];
  closed = false;
  version = '';
  seed: number | null = null;
  bundleActive: boolean | null = null;
  recordingId: string | null = null;

  private constructor(
    readonly conn: Connection,
    readonly pid: number,
    readonly profile: string,
    readonly temp: boolean,
    readonly headless: boolean,
    readonly downloads: string,
  ) {
    conn.on((e) => this.onEvent(e));
  }

  static async open(options: OpenOptions): Promise<Browser> {
    const exe = browserExe();
    if (!exe) {
      throw new ToolError(
        'No browser is installed. Call browser_install (it downloads about 1.6 GB, so ask the user first), ' +
          'or set the path of a chrome.exe in the plugin settings.',
      );
    }
    if (!fs.existsSync(exe)) throw new ToolError(`The configured browser does not exist: ${exe}`);

    let profile: string;
    const temp = options.profile === 'temp';
    if (temp) {
      sweepTempProfiles();
      profile = newProfileDir(true);
    } else if (!options.profile || options.profile === 'new') {
      profile = newProfileDir();
    } else {
      profile = movedProfile(path.resolve(options.profile));
      if (!fs.existsSync(profile)) {
        throw new ToolError(`No profile folder at ${profile}. Pass "new" for a new profile.`);
      }
      if (profileInUse(profile)) {
        throw new ToolError(`The profile at ${profile} is open in another browser. Close that browser first.`);
      }
    }

    const headless = options.headless ?? false;
    const args = [
      ...BASE_SWITCHES,
      `--user-data-dir=${profile}`,
      `--fingerprint-seed=${options.seed ?? 'auto'}`,
      // Headless takes its screen and window place from the seed's profile;
      // headed shows the real monitor and window, which must agree with each
      // other. Headed also shows the pointer the tools move: the browser draws
      // it on a layer of its own over the page, which the page never sees
      // (docs/DESIGN.md, "Launch switches").
      ...(headless
        ? ['--headless=new', '--mute-audio', '--enable-gpu', '--fingerprint-screen=auto', '--fingerprint-screen-position=auto']
        : ['--show-cdp-cursor']),
    ];
    let launched: { conn: Connection; pid: number };
    try {
      launched = await launchOutsideTree(exe, args, temp ? profile : null);
    } catch (e) {
      if (temp) fs.rmSync(profile, { recursive: true, force: true });
      throw e;
    }
    const { conn, pid } = launched;
    const downloads = path.join(profile, 'Downloads');
    fs.mkdirSync(downloads, { recursive: true });
    const browser = new Browser(conn, pid, profile, temp, headless, downloads);
    try {
      const v = await conn.send('Browser.getVersion', {}, undefined, 20_000);
      browser.version = String(v.product ?? '').replace(/^\D+\//, '');
      if (Number(browser.version.split('.')[0]) < MIN_MAJOR) {
        throw new ToolError(
          `This browser is Chromaphore ${browser.version}; the plugin needs ${MIN_MAJOR} or later. ` +
            'Call browser_install for the latest release, or set a newer chrome.exe in the plugin settings.',
        );
      }
      await conn.send('Target.setDiscoverTargets', { discover: true });
      await conn.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloads,
        eventsEnabled: true,
      });
      const f = await conn.send('Browser.getFingerprint').catch(() => null);
      browser.seed = f?.fingerprint?.seed?.master ?? null;
      browser.bundleActive = f?.fingerprint?.fonts?.bundleActive ?? null;
    } catch (e) {
      await conn.send('Browser.close', {}, undefined, 5_000).catch(() => {});
      conn.close();
      throw e;
    }
    return browser;
  }

  // Opens a tab, in a new window when there is none.
  async newTab(url = 'about:blank'): Promise<Tab> {
    const newWindow = this.tabs.size === 0;
    const { targetId } = await this.conn.send('Target.createTarget', { url, newWindow });
    const tab = await this.attach(targetId);
    this.activeTargetId = targetId;
    return tab;
  }

  // The tab with this id (t1, t2, ...), or the active one; attaches to a tab
  // the page opened on first use.
  async tab(id?: string): Promise<Tab> {
    this.assertOpen();
    let targetId: string | undefined;
    if (id) {
      targetId = [...this.tabIds].find(([, t]) => t === id)?.[0];
      if (!targetId || !this.targets.has(targetId)) throw new ToolError(`No tab ${id}. Call tab_list.`);
    } else {
      targetId = this.activeTargetId ?? undefined;
      if (!targetId || !this.targets.has(targetId)) {
        throw new ToolError('No tab is selected. Call tab_list, then tab_select, or tab_new.');
      }
    }
    return this.tabs.get(targetId) ?? this.attach(targetId);
  }

  async select(id: string): Promise<Tab> {
    const tab = await this.tab(id);
    await this.conn.send('Target.activateTarget', { targetId: tab.targetId });
    this.activeTargetId = tab.targetId;
    return tab;
  }

  listTabs(): { id: string; url: string; title: string; active: boolean }[] {
    return [...this.targets]
      .filter(([, t]) => t.type === 'page')
      .map(([targetId, t]) => ({
        id: this.tabIdFor(targetId),
        url: t.url,
        title: t.title,
        active: targetId === this.activeTargetId,
      }));
  }

  async closeTab(id: string): Promise<void> {
    const tab = await this.tab(id);
    await this.conn.send('Target.closeTarget', { targetId: tab.targetId });
  }

  tabIdFor(targetId: string): string {
    let id = this.tabIds.get(targetId);
    if (!id) {
      id = `t${++this.tabCounter}`;
      this.tabIds.set(targetId, id);
    }
    return id;
  }

  takeNotices(): string[] {
    const n = this.notices;
    this.notices = [];
    return n;
  }

  lettersFor(targetId: string, documentId: string): string {
    let letters = lettersByPage.get(this)?.get(`${targetId}/${documentId}`);
    if (!letters) {
      do letters = toLetters(pagesCounted++);
      while (letters === 's' || letters === 't');
      if (!lettersByPage.has(this)) lettersByPage.set(this, new Map());
      lettersByPage.get(this)!.set(`${targetId}/${documentId}`, letters);
      pagesByLetters.set(letters, { browser: this.serial, targetId, documentId, shown: new Map() });
    }
    return letters;
  }

  // Whether the browser still has this target (a tab not closed since).
  hasTarget(targetId: string): boolean {
    return this.targets.has(targetId);
  }

  assertOpen(): void {
    if (this.closed) throw new ToolError('The browser has closed. Call browser_open.');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // A recording stopped before the browser goes keeps its HAR whole.
    if (this.recordingId) {
      await this.conn.send('Browser.stopRecording', { recordingId: this.recordingId }, undefined, 30_000).catch(() => {});
      this.recordingId = null;
    }
    await this.conn.send('Browser.close', {}, undefined, 5_000).catch(() => {});
    this.conn.close();
    this.closed = true;
  }

  private async attach(targetId: string): Promise<Tab> {
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(this, this.tabIdFor(targetId), targetId, sessionId);
    this.tabs.set(targetId, tab);
    // Page events for dialogs and commits; no Runtime domain (docs/DESIGN.md,
    // "Talking to the browser").
    await tab.send('Page.enable');
    return tab;
  }

  private onEvent(e: CdpEvent): void {
    const p = e.params;
    switch (e.method) {
      case 'Connection.closed':
        this.closed = true;
        return;
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const info = p.targetInfo;
        this.targets.set(info.targetId, { url: info.url, title: info.title, type: info.type });
        return;
      }
      case 'Target.targetDestroyed': {
        const tab = this.tabs.get(p.targetId);
        const known = this.targets.get(p.targetId);
        this.targets.delete(p.targetId);
        if (tab) {
          tab.closed = true;
          this.tabs.delete(p.targetId);
        }
        if (known?.type === 'page') this.notices.push(`Tab ${this.tabIdFor(p.targetId)} closed.`);
        if (this.activeTargetId === p.targetId) this.activeTargetId = null;
        return;
      }
      case 'Target.targetCrashed':
        this.notices.push(`Tab ${this.tabIdFor(p.targetId)} crashed (${p.status}).`);
        return;
      case 'Browser.downloadWillBegin':
        this.notices.push(`Download started: ${p.suggestedFilename} from ${p.url}`);
        return;
      case 'Browser.downloadProgress':
        if (p.state === 'completed') this.notices.push(`Download finished: ${p.filePath ?? this.downloads}`);
        if (p.state === 'canceled') this.notices.push('A download was cancelled.');
        return;
      case 'Browser.recordingEnded':
        if (p.recordingId === this.recordingId) this.recordingId = null;
        if (p.reason !== 'stopped') this.notices.push(`The recording ended by itself (${p.reason}): ${p.summary} Files: ${p.path}`);
        return;
    }
    const tab = [...this.tabs.values()].find((t) => t.sessionId === e.sessionId);
    if (!tab) return;
    switch (e.method) {
      case 'Page.javascriptDialogOpening':
        tab.dialogOpened({ type: p.type, message: p.message, defaultPrompt: p.defaultPrompt });
        return;
      case 'Page.javascriptDialogClosed':
        tab.dialog = null;
        return;
      case 'Input.permissionPromptDismissed':
        tab.notices.push(
          `The browser dismissed a permission prompt from ${p.origin} for ${p.permissions.join(', ')}.`,
        );
        return;
      case 'Input.actionOutcome':
        tab.noteEvent(p.event, p.actionId);
        tab.notices.push(`Later, from an earlier action: ${describeEvent(p.event)}.`);
        return;
    }
  }
}

// Each page a listing shows (a tab's document) gets letters of its own for
// the ids it lists: a12 on the first, b12 on the next, and so on. The
// browser's labels start again at a1 in every document, so an id without its
// page would name another element once the tab moved on (actions.ts,
// resolve). The count is the server's, not one browser's, so an id from a
// browser closed since never names a page of the next one; s and t are
// skipped, being the letters of snapshot and tab ids.
const lettersByPage = new WeakMap<Browser, Map<string, string>>();
// What a listing printed of an element, by the browser's label (a12): what the
// agent was shown, for the checks an id gets before it is acted on.
export interface Shown {
  role?: string;
  name?: string;
  reads?: string;
}
interface PageIds {
  browser: number;
  targetId: string;
  documentId: string;
  shown: Map<string, Shown>;
}
const pagesByLetters = new Map<string, PageIds>();
let pagesCounted = 0;
let browsersOpened = 0;

export function pageOf(letters: string): PageIds | null {
  return pagesByLetters.get(letters) ?? null;
}

// 0 -> a, 25 -> z, 26 -> aa, 27 -> ab, ...
function toLetters(n: number): string {
  let s = '';
  for (let k = n + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
  return s;
}

export function describeEvent(ev: any): string {
  switch (ev.kind) {
    case 'navigation': {
      if (ev.isDownload) return `a download from ${ev.url}`;
      const where = ev.mainFrame === false ? 'a frame ' : '';
      const how = ev.sameDocument ? ' (same document)' : '';
      const err = ev.errorText ? ` (${ev.errorText})` : '';
      return `${where}navigation ${ev.state ?? ''} to ${ev.url ?? '?'}${how}${err}`.replace(/\s+/g, ' ');
    }
    case 'newTab':
      return `a new tab opened${ev.url ? ` for ${ev.url}` : ''}`;
    case 'popupBlocked':
      return `a popup was blocked${ev.url ? ` (${ev.url})` : ''}`;
    case 'print':
      return 'the page asked to print (the browser cancels print previews)';
    default:
      return ev.kind;
  }
}

// Retries a Page command while the session has not yet moved to a new
// document's frame host: for a moment after a commit, Page commands answer
// "Not attached to an active page".
export async function onActivePage<T>(fn: () => Promise<T>, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof CdpError) || !/active page/.test(e.message) || Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

// Temporary profiles whose reaper never ran (the machine went down with the
// browser open): any not in use and untouched for an hour. The hour leaves
// alone a folder another server has just made and not yet launched on. The
// folder of versions before 0.2.0 too, which is removed once empty.
function sweepTempProfiles(): void {
  for (const parent of [TEMP_PROFILES_DIR, OLD_TEMP_PROFILES_DIR]) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(parent, entry.name);
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs < 3_600_000 || profileInUse(dir)) continue;
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // In use after all, or half deleted: the next sweep tries again.
      }
    }
  }
  removeOldRootIfEmpty();
}

// Starts the browser through launcher.mjs so it is outside this process's
// tree (docs/DESIGN.md, "Talking to the browser"). For a temporary profile
// the launcher also leaves a process that deletes it once the browser exits.
async function launchOutsideTree(
  exe: string,
  args: string[],
  tempProfile: string | null,
): Promise<{ conn: Connection; pid: number }> {
  const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), 'launcher.mjs');
  const temp = tempProfile ? ['--temp', tempProfile] : [];
  const proc = spawn(process.execPath, [launcher, ...temp, exe, ...args], {
    stdio: ['ignore', 'pipe', 'ignore', 'pipe', 'pipe'],
    detached: true,
    windowsHide: true,
  });
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    proc.stdout!.on('data', (c) => {
      out += c;
      if (out.includes('\n')) resolve(out.trim());
    });
    proc.on('error', reject);
    proc.on('exit', () => resolve(out.trim()));
  });
  if (!/^\d+$/.test(line)) throw new Error(`The browser did not start: ${line || 'no answer from the launcher'}`);
  const conn = new Connection(proc.stdio[3] as any, proc.stdio[4] as any);
  return { conn, pid: Number(line) };
}
