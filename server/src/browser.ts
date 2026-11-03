// One browser process and its tabs. Each tab gets one flat CDP session for
// its whole life: the custom commands keep per-session state (the pointer,
// the settle arm), and the humanized Input commands run only on the tab's own
// session.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpError, Connection, type CdpEvent } from './cdp.js';
import { browserExe, newProfileDir } from './paths.js';

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
  // itself from Chromeleon 1.0.0 on). Prerender2: no hidden prerendered pages
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

  send<T = any>(method: string, params: object = {}, timeoutMs?: number): Promise<T> {
    return this.browser.conn.send<T>(method, params, this.sessionId, timeoutMs);
  }

  takeNotices(): string[] {
    const n = this.notices;
    this.notices = [];
    return n;
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
    if (!options.profile || options.profile === 'new') {
      profile = newProfileDir();
    } else {
      profile = path.resolve(options.profile);
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
      // other.
      ...(headless
        ? ['--headless=new', '--mute-audio', '--enable-gpu', '--fingerprint-screen=auto', '--fingerprint-screen-position=auto']
        : []),
    ];
    const { conn, pid } = await launchOutsideTree(exe, args);
    const downloads = path.join(profile, 'Downloads');
    fs.mkdirSync(downloads, { recursive: true });
    const browser = new Browser(conn, pid, profile, headless, downloads);
    try {
      const v = await conn.send('Browser.getVersion', {}, undefined, 20_000);
      browser.version = String(v.product ?? '').replace(/^\D+\//, '');
      if (Number(browser.version.split('.')[0]) < MIN_MAJOR) {
        throw new ToolError(
          `This browser is Chromeleon ${browser.version}; the plugin needs ${MIN_MAJOR} or later. ` +
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
        tab.notices.push(`Later, from an earlier action: ${describeEvent(p.event)}.`);
        return;
    }
  }
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

function profileInUse(profile: string): boolean {
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

// Starts the browser through launcher.mjs so it is outside this process's
// tree (docs/DESIGN.md, "Talking to the browser").
async function launchOutsideTree(exe: string, args: string[]): Promise<{ conn: Connection; pid: number }> {
  const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), 'launcher.mjs');
  const proc = spawn(process.execPath, [launcher, exe, ...args], {
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
