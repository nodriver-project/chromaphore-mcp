// The tools that work on the whole browser rather than a tab: reading a URL
// without a tab, recording the traffic, and the fingerprint report. These
// commands answer only on the browser target, which is the pipe's own
// session (no sessionId).
import fs from 'node:fs';
import path from 'node:path';
import { ToolError, type Browser } from './browser.js';
import { clip } from './listing.js';
import { withScheme } from './actions.js';

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

export interface FetchOptions {
  url: string;
  mode?: 'auto' | 'raw';
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  links?: boolean;
  max_chars?: number;
}

export async function fetchUrl(b: Browser, o: FetchOptions): Promise<string> {
  const url = withScheme(o.url);
  const r = await b.conn.send(
    'Browser.agentFetch',
    {
      url,
      ...(o.mode ? { mode: o.mode } : {}),
      ...(o.method ? { method: o.method } : {}),
      ...(o.headers ? { headers: o.headers } : {}),
      ...(o.body !== undefined ? { body: o.body } : {}),
      ...(o.links ? { links: true } : {}),
      timeoutMs: 60_000,
    },
    undefined,
    75_000,
  );
  const head = [`${r.outcome}${r.status ? ` ${r.status}` : ''} · ${r.kind}${r.contentType ? ` (${r.contentType})` : ''} · ${r.finalUrl ?? url}`];
  if (r.title) head.push(`Title: ${clip(r.title, 200)}`);
  if (r.redirects?.length) head.push(`Redirects: ${r.redirects.map((x: any) => `${x.status} ${x.url}`).join(' → ')}`);
  if (r.error) head.push(`Error: ${r.error}`);
  if (r.challenge) {
    const c = r.challenge;
    head.push(`Challenge: ${c.vendor ?? 'unknown'} ${c.kind ?? ''}${c.cleared ? ' (cleared)' : ''}${c.rateLimited ? `, rate limited${c.retryAfter ? `, retry after ${c.retryAfter}` : ''}` : ''}`);
  }
  if (r.savedTo) head.push(`Body saved to ${r.savedTo} (${r.bytes} bytes)`);

  const body: string = r.markdown ?? r.text ?? '';
  const max = o.max_chars ?? 40_000;
  let shown = body;
  if (body.length > max) {
    const file = path.join(b.profile, 'fetched', `${stamp()}.${r.markdown ? 'md' : 'txt'}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    shown = `${body.slice(0, max)}\n\n… ${body.length - max} more characters; the whole text is in ${file}`;
  }
  const parts = [head.join('\n')];
  if (shown) parts.push(shown);
  if (o.links && r.links?.length) {
    const links = r.links.slice(0, 300).map((l: any) => `${clip(l.text, 80) || '(no text)'} → ${l.url} [${l.region}]`);
    parts.push(`Links (${r.links.length}${r.links.length > 300 ? ', first 300' : ''}):\n${links.join('\n')}`);
  }
  return parts.join('\n\n');
}

export async function recordStart(
  b: Browser,
  o: { level?: 'network' | 'full'; path?: string; minutes?: number },
): Promise<string> {
  if (b.recordingId) throw new ToolError('A recording is already running; call record_stop first.');
  const dir = path.resolve(o.path ?? path.join(process.cwd(), 'recordings', `rec-${stamp()}`));
  const r = await b.conn.send('Browser.startRecording', {
    level: o.level ?? 'network',
    path: dir,
    ...(o.minutes ? { minutes: o.minutes } : {}),
  });
  b.recordingId = r.recordingId;
  const ends = r.endsAt ? `; it ends by itself at ${new Date(r.endsAt).toLocaleTimeString()}` : '';
  return `Recording ${o.level ?? 'network'} traffic to ${r.path}${ends}. Call record_stop to close the files.`;
}

export async function recordStop(b: Browser): Promise<string> {
  if (!b.recordingId) throw new ToolError('No recording is running.');
  const r = await b.conn.send('Browser.stopRecording', { recordingId: b.recordingId }, undefined, 60_000);
  b.recordingId = null;
  const lines = [`Stopped. ${r.summary}`, `Files: ${r.path} (recording.har, requests.txt to grep, summary.md)`];
  try {
    const summary = fs.readFileSync(path.join(r.path, 'summary.md'), 'utf8');
    lines.push('', summary.length > 6_000 ? `${summary.slice(0, 6_000)}\n… (the rest is in summary.md)` : summary);
  } catch {
    // The one-line summary above stands.
  }
  return lines.join('\n');
}

export async function fingerprint(b: Browser, full = false): Promise<string> {
  const f = (await b.conn.send('Browser.getFingerprint')).fingerprint;
  if (full) {
    const json = JSON.stringify(f, null, 1);
    return json.length > 60_000 ? `${json.slice(0, 60_000)}\n…` : json;
  }
  const s = f.screen ?? {};
  const h = f.hardware ?? {};
  const lines = [
    `Seed ${f.seed?.master ?? 'none'} · ${f.headless ? 'headless' : 'headed'} · Chromium ${f.chromiumVersion}`,
    `User agent: ${f.brand?.userAgent}`,
    `GPU: ${f.gpu?.renderer} (${f.gpu?.vendor})`,
    `Hardware: ${h.concurrency} threads, ${h.deviceMemory} GB · device ${f.device?.type}`,
    `Screen: ${s.width}x${s.height} at ${s.devicePixelRatio}x, ${s.refreshRate ?? '?'} Hz`,
    `Time zone: ${f.place?.timezone} · languages ${f.languages?.navigatorLanguages?.join?.(', ') ?? f.languages?.navigatorLanguages}`,
    `Fonts: bundle ${f.fonts?.bundleActive ? `active (${f.fonts.fileCount} files)` : 'not active (system fonts)'}`,
    `WebRTC: ${f.network?.webrtc?.spoofed ? `reports ${f.network.webrtc.ip4 ?? ''}` : 'real addresses'}`,
  ];
  return lines.join('\n');
}
