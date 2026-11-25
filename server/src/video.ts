// Agent video recording over Chromaphore's Browser.*VideoRecording CDP
// commands. One recording runs per browser, following the selected tab,
// optionally cutting idle time between action tool calls, and writing
// start/end tool markers into the browser's .events.ndjson sidecar.
import fs from 'node:fs';
import path from 'node:path';
import { CdpError, ToolError } from './cdp.js';

export const DEFAULT_MINUTES = 10;
export const MAX_MINUTES = 60;
const LABEL_CHARS = 500;

const START_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 60_000;
const CLEANUP_STOP_MS = 10_000;
const START_SETTLE_MS = 5_000;
const STOPPING_WAIT_MS = 10_000;
const POLL_MS = 250;
const IDLE_AFTER_MS = 1_000;

// Names Windows reserves for devices, with or without an extension.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?\s*$/i;
const BAD_NAME_CHARS = /[<>:"|?*\x00-\x1f]/;

export interface VideoSender {
  send<T = any>(method: string, params?: object, sessionId?: string, timeoutMs?: number): Promise<T>;
}

export interface VideoStartOptions {
  targetId: string;
  path?: string;
  fps: number;
  idle: 'cut' | 'keep';
  width?: number;
  height?: number;
  audio?: boolean;
  maxMinutes?: number;
  cwd?: string;
}

export interface VideoTimingOptions {
  idleAfterMs?: number;
  stopWaitMs?: number;
  startSettleMs?: number;
  stoppingWaitMs?: number;
  pollMs?: number;
}

interface VideoResult {
  path?: string;
  eventsPath?: string;
  width?: number;
  height?: number;
  fps?: number;
  durationMs?: number;
  frames?: number;
  dropped?: number;
  bytes?: number;
  reason?: string;
  encoder?: string;
  audio?: string;
}

interface EndedRecord {
  recordingId: string;
  result: VideoResult;
  filePath: string;
  eventsPath: string;
}

type State = 'free' | 'starting' | 'recording' | 'stopping';
type Hold = 'agent' | 'idle';
type ErrorKind = 'no_recorder' | 'browser_gone' | 'timed_out' | 'refused' | 'other';

function classifyError(e: unknown): { kind: ErrorKind; detail: string } {
  if (e instanceof CdpError) {
    if (e.code === -32601 && /wasn't found/.test(e.message)) {
      return { kind: 'no_recorder', detail: e.message };
    }
    return { kind: 'refused', detail: e.message };
  }
  if (e instanceof Error) {
    if (/the browser is gone/i.test(e.message)) return { kind: 'browser_gone', detail: e.message };
    if (/got no answer within/i.test(e.message)) return { kind: 'timed_out', detail: e.message };
    return { kind: 'other', detail: e.message };
  }
  return { kind: 'other', detail: String(e) };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** The sidecar file the browser writes beside `mp4Path`. */
export function eventsOf(mp4Path: string): string {
  const dir = path.dirname(mp4Path);
  const name = path.basename(mp4Path);
  const stem = name.toLowerCase().endsWith('.mp4') ? name.slice(0, -4) : name;
  return path.join(dir, `${stem}.events.ndjson`);
}

/**
 * Resolves the output .mp4 path, never replacing an existing .mp4 or its
 * .events.ndjson sidecar (auto-numbering " (2)", " (3)", ...).
 * - Omitted: `<cwd>/recordings/video-<timestamp>.mp4`
 * - Bare name (no path separators or drive letter): `<cwd>/recordings/<name>.mp4`
 * - Relative or absolute path: resolved against `cwd`, appending `.mp4` if missing.
 */
export function resolveVideoPath(asked?: string, cwd = process.cwd()): string {
  let dir: string;
  let base: string;
  if (asked === undefined) {
    dir = path.resolve(cwd, 'recordings');
    base = `video-${stamp()}`;
  } else {
    const trimmed = asked.trim();
    if (!trimmed) throw new ToolError('path cannot be empty; omit it for a default file in recordings/.');
    const isBare = !/[\\/:]/.test(trimmed);
    if (isBare) {
      let stem = trimmed;
      if (stem.toLowerCase().endsWith('.mp4')) stem = stem.slice(0, -4);
      stem = stem.trim();
      if (!stem || stem === '.' || stem === '..' || BAD_NAME_CHARS.test(stem)) {
        throw new ToolError('Give the file a name with letters or digits in it.');
      }
      if (RESERVED.test(stem)) {
        throw new ToolError(`"${stem}" is a name Windows keeps for a device; give the file another.`);
      }
      dir = path.resolve(cwd, 'recordings');
      base = stem;
    } else {
      if (/[\\/]$/.test(trimmed)) {
        throw new ToolError('path must name an .mp4 file, not a folder.');
      }
      const resolved = path.resolve(cwd, trimmed);
      dir = path.dirname(resolved);
      let raw = path.basename(resolved);
      if (raw.toLowerCase().endsWith('.mp4')) raw = raw.slice(0, -4);
      raw = raw.trim();
      if (!raw || raw === '.' || raw === '..' || BAD_NAME_CHARS.test(raw)) {
        throw new ToolError('path must end with a valid file name.');
      }
      if (RESERVED.test(raw)) {
        throw new ToolError(`"${raw}" is a name Windows keeps for a device; give the file another.`);
      }
      base = raw;
    }
  }
  let stem = base;
  for (
    let n = 2;
    fs.existsSync(path.join(dir, `${stem}.mp4`)) || fs.existsSync(path.join(dir, `${stem}.events.ndjson`));
    n++
  ) {
    stem = `${base} (${n})`;
  }
  return path.join(dir, `${stem}.mp4`);
}

export function clock(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = String(seconds % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sizeOnDisk(file?: string | null): string {
  if (!file) return '';
  try {
    const st = fs.statSync(file);
    return st.isFile() ? ` (${mb(st.size)})` : '';
  } catch {
    return '';
  }
}

function endedHow(reason?: string): string {
  switch (reason) {
    case 'timeLimit':
      return 'at its time limit';
    case 'targetClosed':
      return 'when its tab closed';
    case 'sessionClosed':
      return "when the browser's connection closed";
    case 'error':
      return 'because the browser could not go on recording';
    case 'stopped':
      return 'when it was stopped';
    default:
      return 'by itself';
  }
}

function formatHandedOver(filePath: string, eventsPath: string | null, r?: VideoResult | null): string {
  let out = filePath;
  if (r && typeof r.durationMs === 'number' && typeof r.frames === 'number' && typeof r.bytes === 'number') {
    out += `: ${clock(r.durationMs)}, ${mb(r.bytes)}, ${r.frames} ${r.frames === 1 ? 'frame' : 'frames'}`;
    if (r.dropped && r.dropped > 0) out += ` (${r.dropped} dropped)`;
  }
  out += '.';
  if (eventsPath) out += ` Events: ${eventsPath}.`;
  return out;
}

function failedMessage(what: string, kind: ErrorKind, detail: string): string {
  switch (kind) {
    case 'no_recorder':
      return 'This browser was not built with a video recorder (needs a Chromaphore build newer than release 2.0.0).';
    case 'browser_gone':
      return 'The browser has gone, and the recording with it.';
    case 'timed_out':
      return `The browser did not answer in time when asked to ${what}. Try again.`;
    default:
      return `The browser would not ${what}${detail ? `: ${detail}` : '.'}`;
  }
}

function deleteFiles(mp4: string | null, events: string | null): string[] {
  const left: string[] = [];
  for (const p of [mp4, events]) {
    if (!p) continue;
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // Checked below.
    }
    if (fs.existsSync(p)) left.push(p);
  }
  return left;
}

export class VideoRecorder {
  private readonly idleAfterMs: number;
  private readonly stopWaitMs: number;
  private readonly startSettleMs: number;
  private readonly stoppingWaitMs: number;
  private readonly pollMs: number;

  private state: State = 'free';
  private recordingId: string | null = null;
  private filePath: string | null = null;
  private eventsPath: string | null = null;
  private cutIdle = false;
  private maxMinutes = DEFAULT_MINUTES;

  private readonly holds = new Set<Hold>();
  private browserPaused = false;
  private pauseUnknown = false;

  private stopUnanswered = false;
  private discardOnStop = false;
  private abandoned = false;
  private earlyEnded: { recordingId: string; result: VideoResult } | null = null;

  private ended: EndedRecord | null = null;
  private endedTold = false;

  private idleToken = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private inFlight = 0;
  private lockChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly sender: VideoSender,
    timing: VideoTimingOptions = {},
  ) {
    this.idleAfterMs = timing.idleAfterMs ?? IDLE_AFTER_MS;
    this.stopWaitMs = timing.stopWaitMs ?? STOP_TIMEOUT_MS;
    this.startSettleMs = timing.startSettleMs ?? START_SETTLE_MS;
    this.stoppingWaitMs = timing.stoppingWaitMs ?? STOPPING_WAIT_MS;
    this.pollMs = timing.pollMs ?? POLL_MS;
  }

  /** The id of an active or stopping recording, for process exit teardown. */
  activeId(): string | null {
    return this.state === 'recording' || this.state === 'stopping' ? this.recordingId : null;
  }

  /** Whether a recording is starting, running, stopping or owed a stop. */
  busy(): boolean {
    return this.state !== 'free';
  }

  // Serializes pause, resume, mark, retarget and resync calls so they never
  // race each other over the pipe. Never re-entered from inside itself.
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lockChain.then(fn, fn);
    this.lockChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private cancelIdleCut(): void {
    this.idleToken++;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleCut(): void {
    if (!this.cutIdle || this.state !== 'recording') return;
    const token = ++this.idleToken;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.holdQuietly('idle', true, token);
    }, this.idleAfterMs);
    this.idleTimer.unref?.();
  }

  private free(): void {
    this.cancelIdleCut();
    this.state = 'free';
    this.recordingId = null;
    this.filePath = null;
    this.eventsPath = null;
    this.holds.clear();
    this.browserPaused = false;
    this.pauseUnknown = false;
    this.stopUnanswered = false;
    this.discardOnStop = false;
    this.abandoned = false;
    this.earlyEnded = null;
  }

  /** Called by Browser.onEvent on `Browser.videoRecordingEnded`. */
  onEnded(params: { recordingId?: string; result?: VideoResult }): void {
    const id = params?.recordingId ?? '';
    const result = params?.result ?? {};
    if (this.state === 'starting') {
      this.earlyEnded = { recordingId: id, result };
      return;
    }
    if ((this.state === 'recording' || this.state === 'stopping') && id && id === this.recordingId) {
      const filePath = result.path ?? this.filePath ?? '';
      const eventsPath = result.eventsPath ?? this.eventsPath ?? (filePath ? eventsOf(filePath) : '');
      this.ended = { recordingId: id, result, filePath, eventsPath };
      this.endedTold = false;
      if (this.state === 'recording') this.free();
    }
  }

  private takeEarlyEnded(id: string): { recordingId: string; result: VideoResult } | null {
    const e = this.earlyEnded;
    this.earlyEnded = null;
    return e && e.recordingId === id ? e : null;
  }

  /** Called by Browser.onEvent on `Connection.closed`. */
  onConnectionClosed(): void {
    this.free();
  }

  /**
   * One-shot notice for the next non-video_stop tool call when a recording
   * ended by itself. The full figures stay stored until `video_stop`.
   */
  takeEndedNotice(): string | null {
    if (!this.ended || this.endedTold || this.discardOnStop) return null;
    this.endedTold = true;
    const e = this.ended;
    return `[since your last call] Your video recording ended ${endedHow(e.result.reason)}: ${e.filePath}. video_stop gives its figures.`;
  }

  // ==================== Start ====================

  async start(o: VideoStartOptions): Promise<string> {
    if (this.state !== 'free') {
      const where = this.state === 'recording' && this.filePath ? ` ${this.filePath}` : '';
      throw new ToolError(`This browser is already recording${where}. Call video_stop first.`);
    }
    const fps = o.fps;
    if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
      throw new ToolError('fps has to be a whole number from 1 to 60.');
    }
    if (o.idle !== 'cut' && o.idle !== 'keep') {
      throw new ToolError('idle has to be "cut" or "keep".');
    }
    if (
      (o.width !== undefined && (!Number.isInteger(o.width) || o.width < 2)) ||
      (o.height !== undefined && (!Number.isInteger(o.height) || o.height < 2))
    ) {
      throw new ToolError('width and height have to be whole numbers of pixels, 2 or more.');
    }
    const maxMinutes = o.maxMinutes ?? DEFAULT_MINUTES;
    if (!Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > MAX_MINUTES) {
      throw new ToolError(`max_minutes has to be a whole number from 1 to ${MAX_MINUTES}.`);
    }
    const audio = o.audio ?? true;
    const filePath = resolveVideoPath(o.path, o.cwd);
    const eventsPath = eventsOf(filePath);

    // Clear any unconsumed ended record from an earlier recording.
    this.ended = null;
    this.endedTold = false;

    this.state = 'starting';
    this.filePath = filePath;
    this.eventsPath = eventsPath;
    this.cutIdle = o.idle === 'cut';
    this.maxMinutes = maxMinutes;
    this.holds.clear();
    this.browserPaused = false;
    this.pauseUnknown = false;
    this.stopUnanswered = false;
    this.discardOnStop = false;
    this.abandoned = false;
    this.earlyEnded = null;

    // Pre-start status check: detects older builds and external recordings.
    try {
      const status = await this.sender.send('Browser.videoRecordingStatus', {}, undefined, COMMAND_TIMEOUT_MS);
      if (status?.recording) {
        this.free();
        throw new ToolError(
          'This browser is already recording something this session did not start, so nothing was started and it was left alone.',
        );
      }
    } catch (e) {
      this.free();
      if (e instanceof ToolError) throw e;
      const err = classifyError(e);
      throw new ToolError(failedMessage('start recording', err.kind, err.detail));
    }

    let started: any;
    try {
      started = await this.sender.send(
        'Browser.startVideoRecording',
        {
          targetId: o.targetId,
          path: filePath,
          fps,
          ...(o.width !== undefined ? { width: o.width } : {}),
          ...(o.height !== undefined ? { height: o.height } : {}),
          maxMinutes,
          audio,
          redact: false,
        },
        undefined,
        START_TIMEOUT_MS,
      );
    } catch (e) {
      const err = classifyError(e);
      if (err.kind === 'timed_out') {
        const msg = await this.recoverTimedOutStart(filePath, eventsPath);
        throw new ToolError(msg);
      }
      this.free();
      throw new ToolError(failedMessage('start recording', err.kind, err.detail));
    }

    const id: string = started.recordingId;
    const actualEvents: string = started.eventsPath ?? eventsPath;
    const early = this.takeEarlyEnded(id);
    const closedMeanwhile = this.abandoned;

    this.recordingId = id;
    this.eventsPath = actualEvents;
    this.state = 'recording';

    if (closedMeanwhile) {
      this.state = 'stopping';
      await this.stopQuietly(id, CLEANUP_STOP_MS);
      this.free();
      throw new ToolError('The browser has gone, and the recording with it.');
    }

    if (early) {
      this.onEnded(early);
    } else if (this.cutIdle) {
      this.scheduleIdleCut();
    }

    return `Recording ${filePath} at ${started.width}x${started.height}, ${fps} fps; it ends itself after ${maxMinutes} min of recorded time.`;
  }

  private async recoverTimedOutStart(filePath: string, eventsPath: string): Promise<string> {
    this.state = 'stopping';
    this.discardOnStop = true;
    const s = await this.settle(null, this.startSettleMs, CLEANUP_STOP_MS);
    switch (s.how) {
      case 'not_running':
        this.free();
        return 'The browser did not answer in time when asked to start recording; nothing was started. Try again.';
      case 'stopped':
      case 'browser_gone': {
        this.free();
        const left = deleteFiles(filePath, eventsPath);
        if (left.length) {
          return `The browser did not answer in time when asked to start recording; it stopped, but could not delete ${left.join(' and ')}.`;
        }
        return 'The browser did not answer in time when asked to start recording; what it began was stopped and its files deleted. Try again.';
      }
      case 'still_running':
        this.stopUnanswered = true;
        if (s.foundId) this.recordingId = s.foundId;
        return `The start timed out, and the browser went on with a recording into ${filePath} that it would not stop yet. Call video_stop to stop it and delete its files.`;
    }
  }

  // ==================== Holds: agent pause/resume & idle cut ====================

  async pause(): Promise<string> {
    return this.agentHold(true);
  }

  async resume(): Promise<string> {
    return this.agentHold(false);
  }

  private async agentHold(pause: boolean): Promise<string> {
    const res = await this.withLock(async () => {
      await this.resyncPauseLocked();
      if (this.state !== 'recording') {
        throw new ToolError('Nothing is recording.');
      }
      if (!pause && !this.holds.has('agent')) {
        const at = await this.statusTime();
        return `It was not paused${this.atClause(at)}.`;
      }
      try {
        const at = await this.holdLocked('agent', pause, -1);
        const shown = at === -2 ? await this.statusTime() : at;
        if (!pause && this.cutIdle && this.holds.has('idle')) {
          return `Resumed${this.atClause(shown)}; with idle cut it records again from the next action.`;
        }
        return `${pause ? 'Paused' : 'Resumed'}${this.atClause(shown)}.`;
      } catch (e) {
        const err = classifyError(e);
        if (err.kind === 'refused') {
          if (pause) this.holds.delete('agent');
          else this.holds.add('agent');
        }
        if (this.state !== 'recording') throw new ToolError('Nothing is recording.');
        throw new ToolError(failedMessage(pause ? 'pause' : 'resume', err.kind, err.detail));
      }
    });
    return res;
  }

  // Must run inside withLock.
  private async holdLocked(hold: Hold, on: boolean, token: number): Promise<number> {
    await this.resyncPauseLocked();
    if (this.state !== 'recording' || !this.recordingId) return -1;
    if (token >= 0 && token !== this.idleToken) return -1;
    if (on) this.holds.add(hold);
    else this.holds.delete(hold);
    const want = this.holds.size > 0;
    if (want === this.browserPaused) return -2;
    const id = this.recordingId;
    try {
      const r = await this.sender.send(
        want ? 'Browser.pauseVideoRecording' : 'Browser.resumeVideoRecording',
        { recordingId: id, label: hold },
        undefined,
        COMMAND_TIMEOUT_MS,
      );
      this.browserPaused = want;
      return typeof r?.mediaTimeMs === 'number' ? r.mediaTimeMs : -1;
    } catch (e) {
      const err = classifyError(e);
      if (err.kind !== 'refused') this.pauseUnknown = true;
      throw e;
    }
  }

  private async holdQuietly(hold: Hold, on: boolean, token: number): Promise<void> {
    try {
      await this.withLock(() => this.holdLocked(hold, on, token));
    } catch {
      // Background / best-effort hold: leave for next resync or stop.
    }
  }

  // Must run inside withLock.
  private async resyncPauseLocked(): Promise<void> {
    if (!this.pauseUnknown || this.state !== 'recording') return;
    try {
      const now = await this.sender.send('Browser.videoRecordingStatus', {}, undefined, COMMAND_TIMEOUT_MS);
      this.browserPaused = now?.state === 'paused';
      this.pauseUnknown = false;
      if (this.browserPaused && this.holds.size === 0) this.holds.add('agent');
    } catch {
      // Leave pauseUnknown true until status answers.
    }
  }

  private async statusTime(): Promise<number> {
    try {
      const now = await this.sender.send('Browser.videoRecordingStatus', {}, undefined, COMMAND_TIMEOUT_MS);
      return now?.recording && typeof now.mediaTimeMs === 'number' ? now.mediaTimeMs : -1;
    } catch {
      return -1;
    }
  }

  private atClause(elapsedMs: number): string {
    if (elapsedMs < 0) return '';
    const left = this.maxMinutes > 0 ? Math.max(0, this.maxMinutes * 60_000 - elapsedMs) : -1;
    return ` at ${clock(elapsedMs)}${left >= 0 ? `, ${clock(left)} left` : ''}`;
  }

  // ==================== Marks, tool hooks & tab following ====================

  async mark(rawLabel: string): Promise<string> {
    const trimmed = rawLabel.trim();
    if (!trimmed) throw new ToolError('video_mark needs a label.');
    const chars = [...trimmed];
    const label = chars.length > LABEL_CHARS ? chars.slice(0, LABEL_CHARS).join('') : trimmed;
    return this.withLock(async () => {
      if (this.state !== 'recording' || !this.recordingId) {
        throw new ToolError('Nothing is recording.');
      }
      try {
        const r = await this.sender.send(
          'Browser.markVideoRecording',
          { recordingId: this.recordingId, event: JSON.stringify({ label }) },
          undefined,
          COMMAND_TIMEOUT_MS,
        );
        const at = typeof r?.mediaTimeMs === 'number' ? r.mediaTimeMs : -1;
        return `Marked${this.atClause(at)}.`;
      } catch (e) {
        if (this.state !== 'recording') throw new ToolError('Nothing is recording.');
        const err = classifyError(e);
        throw new ToolError(failedMessage('mark', err.kind, err.detail));
      }
    });
  }

  private async markQuietly(event: Record<string, unknown>): Promise<void> {
    try {
      await this.withLock(async () => {
        if (this.state !== 'recording' || !this.recordingId) return;
        await this.sender.send(
          'Browser.markVideoRecording',
          { recordingId: this.recordingId, event: JSON.stringify(event) },
          undefined,
          COMMAND_TIMEOUT_MS,
        );
      });
    } catch {
      // Best-effort sidecar marker.
    }
  }

  async toolStarted(tool: string): Promise<void> {
    this.inFlight++;
    if (this.state !== 'recording') return;
    this.cancelIdleCut();
    if (this.cutIdle) await this.holdQuietly('idle', false, -1);
    await this.markQuietly({ type: 'tool', tool, at: 'start' });
  }

  async toolEnded(tool: string, ok: boolean): Promise<void> {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.state !== 'recording') return;
    await this.markQuietly({ type: 'tool', tool, at: 'end', ok });
    if (this.inFlight === 0) this.scheduleIdleCut();
  }

  async follow(targetId: string): Promise<void> {
    if (this.state !== 'recording' || !this.recordingId) return;
    try {
      await this.withLock(async () => {
        if (this.state !== 'recording' || !this.recordingId) return;
        await this.sender.send(
          'Browser.setVideoRecordingTarget',
          { recordingId: this.recordingId, targetId },
          undefined,
          COMMAND_TIMEOUT_MS,
        );
      });
    } catch {
      // Best-effort follow: old tab keeps recording if retarget fails.
    }
  }

  // ==================== Stop & teardown ====================

  async stop(): Promise<string> {
    let id: string | null;
    let filePath: string | null;
    let eventsPath: string | null;
    let owed: boolean;

    if (this.state === 'recording') {
      this.state = 'stopping';
      this.cancelIdleCut();
      id = this.recordingId;
      filePath = this.filePath;
      eventsPath = this.eventsPath;
      owed = false;
    } else if (this.state === 'stopping' && this.stopUnanswered) {
      this.stopUnanswered = false;
      id = this.recordingId;
      filePath = this.filePath;
      eventsPath = this.eventsPath;
      owed = true;
    } else if (this.state === 'stopping') {
      return this.unansweredMessage(this.filePath, this.discardOnStop);
    } else if (this.ended) {
      const e = this.takeEnded();
      return `It had already ended ${endedHow(e.result.reason)}. Saved ${formatHandedOver(e.filePath, e.eventsPath, e.result)}`;
    } else {
      throw new ToolError('Nothing is recording.');
    }

    try {
      return owed
        ? await this.settleOwed(id, filePath, eventsPath)
        : await this.stopRunning(id!, filePath!, eventsPath!);
    } catch (e) {
      if (e instanceof ToolError) throw e;
      this.free();
      throw e;
    }
  }

  private async stopRunning(id: string, filePath: string, eventsPath: string): Promise<string> {
    try {
      const r = await this.sender.send('Browser.stopVideoRecording', { recordingId: id }, undefined, this.stopWaitMs);
      return this.finishStop(r?.result ?? {}, filePath, eventsPath);
    } catch (e) {
      const err = classifyError(e);
      if (err.kind === 'timed_out' || err.kind === 'other') {
        this.stopUnanswered = true;
        throw new ToolError(this.unansweredMessage(filePath, this.discardOnStop));
      }
      if (err.kind === 'browser_gone') {
        this.free();
        throw new ToolError('The browser has gone, and the recording with it.');
      }
      // Refused (e.g. already ended or stopping): check status before reporting.
      return this.settleOwed(id, filePath, eventsPath);
    }
  }

  private async settleOwed(id: string | null, filePath: string | null, eventsPath: string | null): Promise<string> {
    const s = await this.settle(id, this.stoppingWaitMs, this.stopWaitMs);
    const discard = this.discardOnStop;
    switch (s.how) {
      case 'stopped':
        return this.finishStop(s.result ?? {}, filePath ?? '', eventsPath);
      case 'not_running': {
        const was = id && this.ended?.recordingId === id ? this.takeEnded() : null;
        this.free();
        if (discard) return this.discardedMessage(filePath, eventsPath);
        if (was) {
          return `It had already ended ${endedHow(was.result.reason)}. Saved ${formatHandedOver(was.filePath, was.eventsPath, was.result)}`;
        }
        if (filePath && fs.existsSync(filePath)) {
          const side = eventsPath ? ` Events: ${eventsPath}.` : '';
          return `It is no longer recording; its figures were not kept. Saved ${filePath}${sizeOnDisk(filePath)}.${side}`;
        }
        return `It is no longer recording, and no file is at ${filePath ?? 'the expected path'}.`;
      }
      case 'browser_gone':
        this.free();
        if (discard) return this.discardedMessage(filePath, eventsPath);
        throw new ToolError('The browser has gone, and the recording with it.');
      case 'still_running':
        this.stopUnanswered = true;
        if (s.foundId) this.recordingId = s.foundId;
        throw new ToolError(this.unansweredMessage(filePath, discard));
    }
  }

  private finishStop(result: VideoResult, filePath: string, eventsPath: string | null): string {
    const discard = this.discardOnStop;
    this.ended = null;
    this.endedTold = false;
    this.free();
    if (discard) return this.discardedMessage(filePath, eventsPath);
    const finalPath = result.path ?? filePath;
    const finalEvents = result.eventsPath ?? eventsPath;
    return `Saved ${formatHandedOver(finalPath, finalEvents, result)}`;
  }

  private discardedMessage(filePath: string | null, eventsPath: string | null): string {
    const left = deleteFiles(filePath, eventsPath);
    if (left.length) {
      throw new ToolError(`The recording whose start timed out stopped, but could not delete ${left.join(' and ')}.`);
    }
    return 'The recording whose start was cut short is stopped and its files deleted.';
  }

  private unansweredMessage(filePath: string | null, discard: boolean): string {
    if (discard) {
      return `The start timed out, and the browser went on with a recording into ${filePath ?? 'the file'} that it would not stop yet. Call video_stop to stop it and delete its files.`;
    }
    return `The browser did not say the file was finished: it may still be writing it, or it did not answer. The file is ${filePath ?? 'unknown'}. Calling video_stop again is safe, and it will report the file.`;
  }

  private takeEnded(): EndedRecord {
    const e = this.ended!;
    this.ended = null;
    this.endedTold = false;
    return e;
  }

  private async settle(
    id: string | null,
    boundMs: number,
    stopWait: number,
  ): Promise<{ how: 'stopped' | 'not_running' | 'still_running' | 'browser_gone'; result?: VideoResult; foundId: string | null }> {
    const deadline = Date.now() + boundMs;
    let found = id;
    for (;;) {
      let now: any;
      try {
        now = await this.sender.send('Browser.videoRecordingStatus', {}, undefined, COMMAND_TIMEOUT_MS);
      } catch (e) {
        const err = classifyError(e);
        return { how: err.kind === 'browser_gone' ? 'browser_gone' : 'still_running', foundId: found };
      }
      if (!now?.recording || (id && id !== now.recordingId)) {
        return { how: 'not_running', foundId: found };
      }
      found = now.recordingId ?? found;
      if (now.state !== 'stopping' && found) {
        try {
          const r = await this.sender.send('Browser.stopVideoRecording', { recordingId: found }, undefined, stopWait);
          return { how: 'stopped', result: r?.result ?? {}, foundId: found };
        } catch (e) {
          const err = classifyError(e);
          if (err.kind === 'browser_gone') return { how: 'browser_gone', foundId: found };
          if (err.kind !== 'refused') return { how: 'still_running', foundId: found };
        }
      }
      if (Date.now() > deadline) {
        return { how: 'still_running', foundId: found };
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  private async stopQuietly(id: string, waitMs: number): Promise<boolean> {
    try {
      await this.sender.send('Browser.stopVideoRecording', { recordingId: id }, undefined, waitMs);
      return true;
    } catch {
      return false;
    }
  }

  /** Stops any active recording before the browser closes. Never throws. */
  async shutDown(capMs = 30_000): Promise<string | null> {
    let id: string | null = null;
    let owed = false;
    if (this.state === 'starting') {
      this.abandoned = true;
      return null;
    }
    if (this.state === 'stopping' && this.stopUnanswered) {
      this.stopUnanswered = false;
      id = this.recordingId;
      owed = true;
    } else if (this.state === 'recording') {
      this.state = 'stopping';
      this.cancelIdleCut();
      id = this.recordingId;
    } else {
      return null;
    }
    const filePath = this.filePath;
    const eventsPath = this.eventsPath;
    const discard = this.discardOnStop;
    let saved: string | null = null;
    try {
      let result: VideoResult | null = null;
      if (owed) {
        const s = await this.settle(id, capMs, capMs);
        if (s.how === 'stopped') result = s.result ?? {};
      } else if (id) {
        const r = await this.sender.send('Browser.stopVideoRecording', { recordingId: id }, undefined, capMs);
        result = r?.result ?? {};
      }
      if (!discard && result && (result.path ?? filePath)) {
        const finalPath = result.path ?? filePath!;
        const finalEvents = result.eventsPath ?? eventsPath;
        saved = `Saved ${formatHandedOver(finalPath, finalEvents, result)}`;
      }
    } catch {
      // Teardown boundary: browser close goes on regardless.
    } finally {
      this.free();
      if (discard) deleteFiles(filePath, eventsPath);
    }
    return saved;
  }
}
