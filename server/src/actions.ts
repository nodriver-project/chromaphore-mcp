// What each browser tool does with the custom CDP commands. Every action ends
// the same way: the browser's settle for that action, then a listing of what
// changed since the tab's last one.
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { CdpError } from './cdp.js';
import { ToolError, describeEvent, onActivePage, pageOf, predates, type Shown, type Tab } from './browser.js';
import { aim, canvasChange, canvasSection, caution, linesOf, normalise, readCanvas, type CanvasRead, type Line } from './canvas.js';
import { editorLines } from './editors/index.js';
import { clip, formatChange, formatListing, formatQuietChange, settleLine } from './listing.js';

// Screenshots kept for `view`, newest last. The browser shrinks a large
// view's screenshot to about 1,125,000 pixels: `scale` is the image's pixels
// per CSS pixel of the view (Page.AgentSnapshotViewport.screenshotScale), so a
// point read off the image is at x / scale, y / scale in the view.
export interface KeptImage {
  data: string;
  mimeType: string;
  letters: string;
  scale: number;
  view: { width: number; height: number };
  targetId: string;
}
const images = new Map<string, KeptImage>();
let snapshotCounter = 0;
const KEEP_IMAGES = 8;

export function image(snapshotId: string): KeptImage {
  const img = images.get(snapshotId);
  if (!img) throw new ToolError(`No snapshot ${snapshotId} (only the last ${KEEP_IMAGES} are kept). Call observe again.`);
  return img;
}

export function keepImage(base64: string | undefined, img: Omit<KeptImage, 'data' | 'mimeType'>): string | null {
  if (!base64) return null;
  const id = `s${++snapshotCounter}`;
  images.set(id, { data: base64, mimeType: 'image/jpeg', ...img });
  while (images.size > KEEP_IMAGES) images.delete(images.keys().next().value!);
  return id;
}

// What view says beside an image that is not at the view's own size.
export function scaleNote(img: KeptImage): string | null {
  if (img.scale === 1) return null;
  const s = Math.round(img.scale * 1000) / 1000;
  const w = Math.round(img.view.width * img.scale);
  const h = Math.round(img.view.height * img.scale);
  return (
    `The image is ${w}x${h} pixels of a ${img.view.width}x${img.view.height} view (scale ${s}): ` +
    `a point read off it is at x÷${s}, y÷${s} in the view, or pass it as image pixels with snapshot_id.`
  );
}

// Points given as pixels of a snapshot's image, made points of the view. The
// snapshot must be of this tab's current page: an image of another one shows
// another layout.
export function pointsOfImage(tab: Tab, snapshotId: string, points: (Point | null)[]): (Point | null)[] {
  const img = image(snapshotId);
  if (img.targetId !== tab.targetId) {
    throw new ToolError(`${snapshotId} is a snapshot of another tab, not of the selected tab ${tab.id}. Take the point from a view of this tab.`);
  }
  if (img.letters !== tab.letters) {
    throw new ToolError(`${snapshotId} is a snapshot of a page this tab has since left. Call observe, then view the new snapshot.`);
  }
  return points.map((p) => (p ? { x: p.x / img.scale, y: p.y / img.scale } : null));
}

// --- settle and capture -------------------------------------------------

async function settle(tab: Tab, armId?: number): Promise<any> {
  const call = (params: object) => onActivePage(() => tab.send('Page.agentSettle', params, 70_000));
  try {
    return await call(armId === undefined ? {} : { armId });
  } catch (e) {
    // Another action armed since (a later key, a page timer's arm): settle now.
    if (armId !== undefined && e instanceof CdpError && /current action/.test(e.message)) return call({});
    throw e;
  }
}

async function capture(tab: Tab, params: object): Promise<any> {
  const full = { format: 'jpeg', quality: 80, scope: 'on', ...params };
  try {
    return await onActivePage(() => tab.send('Page.captureAgentSnapshot', full, 30_000));
  } catch (e) {
    if (!(e instanceof CdpError) || !/changed document during the capture/.test(e.message)) throw e;
    await settle(tab);
    return onActivePage(() => tab.send('Page.captureAgentSnapshot', full, 30_000));
  }
}

function remember(tab: Tab, snap: any): string | null {
  tab.letters = tab.browser.lettersFor(tab.targetId, snap.documentId);
  tab.lastListingId = snap.listingId;
  // An element shown before is kept as it is now, printed or not, as
  // NoDriver's ListingMemory.given keeps it: what a reply leaves out of a
  // delta (a title that changed with the name the same) is not a change the
  // agent missed.
  const shown = pageOf(tab.letters)?.shown;
  for (const e of snap.elements ?? []) {
    if (shown && e.label && shown.has(e.label)) shown.set(e.label, { role: e.role, name: e.name, reads: e.reads });
  }
  tab.viewport = { width: snap.viewport.width, height: snap.viewport.height };
  return keepImage(snap.screenshot, {
    letters: tab.letters,
    scale: snap.viewport.screenshotScale ?? 1,
    view: { ...tab.viewport },
    targetId: tab.targetId,
  });
}

function noticesOf(tab: Tab): string[] {
  return [...tab.browser.takeNotices(), ...tab.takeNotices()];
}

function withSnapshotId(text: string, id: string | null): string {
  return id ? `${text}\n\nsnapshot_id ${id} (view shows it marked)` : text;
}

function dialogLine(tab: Tab): string {
  const d = tab.dialog!;
  return `A ${d.type} dialog opened: ${JSON.stringify(d.message)}. The page waits until it is answered; call dialog.`;
}

// --- canvas text (a browser newer than release 2.0.0) --------------------

// The listing's last section: the text the 2D canvases in view show, as
// lines (canvas.ts). The tab remembers the lines for the changes after its
// next action, or that there were none, so a page without canvas text costs
// no read after an action. A read that fails or meets a dialog adds nothing.
async function canvasRead(tab: Tab) {
  const r = await tab.untilDialog(readCanvas(tab).catch(() => null));
  if (r === 'dialog' || !r) return null;
  return { read: r, lines: linesOf(r) };
}

// What an editor module (editors/) says of the page: its caret and selection
// as text, or null when no module knows the page. A failure or a dialog adds
// nothing.
async function editorSays(tab: Tab, c: { read: CanvasRead; lines: Line[] }): Promise<string[] | null> {
  const evaluate = async (expression: string) => {
    const contextId = await worldOf(tab);
    const r = await tab.send('Runtime.evaluate', { expression, contextId, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value ?? null;
  };
  const r = await tab.untilDialog(editorLines({ read: c.read, lines: c.lines, evaluate }).catch(() => null));
  return r === 'dialog' || !r ? null : ['', ...r];
}

// The tab keeps the lines of a page that showed canvas text or that an
// editor module knows (an empty document shows none), so the next action
// reads again.
function keepCanvas(tab: Tab, lines: Line[], editor: string[] | null): void {
  tab.canvas = lines.length || editor ? { letters: tab.letters, lines: lines.map((l) => l.text) } : null;
}

async function canvasListing(tab: Tab): Promise<string[]> {
  tab.canvas = null;
  if (!tab.browser.modern) return [];
  const c = await canvasRead(tab);
  if (!c) return [];
  const editor = await editorSays(tab, c);
  keepCanvas(tab, c.lines, editor);
  return [...canvasSection(c.read, c.lines), ...(editor ?? [])];
}

// After an action: the whole section when the answer is a whole listing (a
// new page), else what changed since the tab's last read on this page; then
// what an editor module says.
async function canvasAfter(tab: Tab, wholeListing: boolean): Promise<string[]> {
  if (wholeListing) return canvasListing(tab);
  const before = tab.canvas;
  if (!tab.browser.modern || !before || before.letters !== tab.letters) {
    tab.canvas = null;
    return [];
  }
  const c = await canvasRead(tab);
  if (!c) return [];
  const editor = await editorSays(tab, c);
  keepCanvas(tab, c.lines, editor);
  return [...canvasChange(before.lines, c.lines), ...(editor ?? [])];
}

// The end of every action: settle on the action's own arm, then what changed.
// Quiet leaves out the element lines (what opened on top, focus and
// announcements stay), for editors whose every key changes much of the page.
async function afterAction(tab: Tab, said: string[], outcome?: any, quiet = false): Promise<string> {
  const lines = [...said];
  for (const ev of outcome?.events ?? []) lines.push(`It led to ${describeEvent(ev)}.`);
  const work = (async () => {
    const report = await settle(tab, outcome?.actionId);
    const snap = await capture(tab, tab.lastListingId ? { since: tab.lastListingId } : {});
    return { report, snap };
  })();
  const r = await tab.untilDialog(work);
  if (r === 'dialog') return [...lines, ...noticesOf(tab), dialogLine(tab)].join('\n');
  const unsettled = settleLine(r.report);
  if (unsettled) lines.push(unsettled);
  const id = remember(tab, r.snap);
  const whole = !quiet && (!r.snap.delta || r.snap.baseline === false);
  const change = quiet ? formatQuietChange(r.snap, tab.letters) : formatChange(r.snap, tab.id, tab.letters, shownOn(tab));
  lines.push(...noticesOf(tab), '', change, ...(await canvasAfter(tab, whole)));
  return withSnapshotId(lines.join('\n'), id);
}

export async function observe(tab: Tab, offscreen?: string, scope?: string): Promise<string> {
  assertNoDialog(tab);
  await settle(tab);
  const snap = await capture(tab, { offscreenMode: offscreen ?? 'summary', scope: scope ?? 'on' });
  const id = remember(tab, snap);
  const listing = formatListing(snap, tab.id, tab.letters, shownOn(tab));
  return withSnapshotId([...noticesOf(tab), listing, ...(await canvasListing(tab))].join('\n'), id);
}

// --- the pointer --------------------------------------------------------

async function viewCentre(tab: Tab): Promise<{ x: number; y: number }> {
  if (!tab.viewport) {
    const m = await onActivePage(() => tab.send('Page.getLayoutMetrics'));
    tab.viewport = { width: m.cssVisualViewport.clientWidth, height: m.cssVisualViewport.clientHeight };
  }
  return { x: Math.round(tab.viewport.width / 2), y: Math.round(tab.viewport.height / 2) };
}

// The browser knows the pointer from the last mouse path in the session; for
// a tab it has not moved in yet, the view's centre.
async function pointerParams(tab: Tab): Promise<{ pointerX: number; pointerY: number }> {
  const p = tab.pointer ?? (await viewCentre(tab));
  return { pointerX: p.x, pointerY: p.y };
}

async function withPointer<T>(tab: Tab, call: (p: { pointerX: number; pointerY: number }) => Promise<T>): Promise<T> {
  try {
    return await call(await pointerParams(tab));
  } catch (e) {
    if (!(e instanceof CdpError) || !/outside the page's view/.test(e.message)) throw e;
    tab.pointer = await viewCentre(tab);
    return call(await pointerParams(tab));
  }
}

// --- elements -----------------------------------------------------------

// An id (b12) is the browser's label for the element (a12) with the letters
// of the page that listed it in place of the a. Labels start again at a1 in
// every document, so the letters keep an id from an earlier page, or from
// another tab, from naming whatever has that label now: such an id is refused.
// The label then gives the element's agentNodeId (Page.agentNodesAlive),
// which Page.resolveAgentNode takes.
interface Target {
  backendNodeId: number;
  frameId: string;
  label: string;
}

async function resolve(tab: Tab, id: string): Promise<Target> {
  const m = /^([a-z]+)(\d+)$/i.exec(id.trim());
  if (!m) throw new ToolError(`"${id}" is not an element id; ids look like a12 and come from the listings.`);
  const page = pageOf(m[1].toLowerCase());
  if (!page) throw new ToolError(`${id} is not an id any listing gave. Call observe for current ids.`);
  if (page.browser !== tab.browser.serial) {
    throw new ToolError(`${id} is from a browser closed since. Call observe for current ids.`);
  }
  if (page.targetId !== tab.targetId) {
    throw new ToolError(
      tab.browser.hasTarget(page.targetId)
        ? `${id} is an element of tab ${tab.browser.tabIdFor(page.targetId)}, not of the selected tab ${tab.id}: tab_select it first, or use an id from this tab's listing.`
        : `${id} is from a tab closed since. Call observe for current ids.`,
    );
  }
  // A load under way: the renderer would hold the lookup until it lands, and
  // the ids are of the page that is leaving.
  if (tab.navigationPending()) {
    throw new ToolError(
      `${id} is of a page that is loading a new document: its ids will be gone when it lands. Call observe once it has.`,
    );
  }
  const label = `a${m[2]}`;
  const life = await onActivePage(() => tab.send('Page.agentNodesAlive', { labels: [label], layers: true }));
  if (life.documentId !== page.documentId) {
    throw new ToolError(
      `${id} is from a page this tab has since left (a navigation or a reload replaced it). Use the ids of the latest listing, or call observe.`,
    );
  }
  const node0 = life.nodes?.[0];
  const refused = node0 ? idRefusal(id, node0, page.shown, label) : null;
  if (refused) throw new ToolError(refused);
  const node =
    node0?.agentNodeId === undefined || node0.state === 'gone'
      ? { found: false }
      : await onActivePage(() => tab.send('Page.resolveAgentNode', { agentNodeId: node0.agentNodeId }));
  if (!node.found) throw new ToolError(`${id} is no longer on the page or not laid out. Call observe for current ids.`);
  return { backendNodeId: node.backendNodeId, frameId: node.localRootFrameId, label: id };
}

// What a listing printed is kept as what the agent was shown on that page.
function shownOn(tab: Tab): (e: any) => void {
  const shown = pageOf(tab.letters)?.shown;
  return (e) => {
    if (shown && e.label) shown.set(e.label, { role: e.role, name: e.name, reads: e.reads });
  };
}

// Why an element named by an id is not to be acted on now, or null. The
// same checks as NoDriver's (bridge/session/IdCheck.java): an element gone,
// one off screen the agent was never shown, one behind a layer open on top or
// that was behind one that has closed, one no longer listed, and one that no
// longer reads as it did when the agent saw it. An element whose frame did
// not answer is let through: the action checks what it reaches.
function idRefusal(id: string, life: any, shown: Map<string, Shown>, label: string): string | null {
  const seen = shown.get(label);
  const what = described(seen ?? life);
  switch (life.state) {
    case 'elsewhere':
      return `${id} is not an element of this page. Call observe for current ids.`;
    case 'gone':
      return `${id} (${what}) is no longer on the page. Call observe for current ids.`;
    case 'alive':
      break;
    default:
      return null;
  }
  const placement = life.placement ?? '';
  if (placement === 'dropped' && !seen) {
    return `${id} is not an id you were shown: it names something off screen that the listing left out. Use an id from a listing, or observe with offscreen "full".`;
  }
  if (placement === 'behind') {
    const layer = layerName(life.behind);
    if (life.behindOpen === false) {
      return `${id} (${what}) was behind ${layer} when the page was last listed, and that has closed since. Call observe, then retry.`;
    }
    const escape = life.behind?.kind === 'listbox' || life.behind?.kind === 'menu';
    return `${id} (${what}) is behind ${layer} now, so nothing can reach it. ${escape ? 'Close it first - Escape usually does - or pick from it.' : 'Close that first, or act on what it shows.'}`;
  }
  if (placement === 'unlisted') {
    return `${id} (${what}) is on the page but no longer listed: hidden, or no longer something to act on. Call observe.`;
  }
  if (seen && life.reads && !stillReads(seen, life.reads)) {
    const was = seen.reads ? described({ role: seen.role, name: headOf(seen.reads) }) : what;
    // Told now: a retry acts on what it reads as.
    shown.set(label, { role: life.role, name: headOf(life.reads), reads: life.reads });
    return `${id} was ${was} when you saw it; it now reads "${headOf(life.reads)}". Call observe if the page has moved on, or act on what it is now.`;
  }
  return null;
}

function described(e: { role?: string; name?: string; reads?: string }): string {
  const role = e.role === 'StaticText' || e.role === 'generic' ? 'text' : e.role === 'LabelText' ? 'label' : e.role ?? 'element';
  const name = e.name || (e.reads ? headOf(e.reads) : '');
  return name ? `${role} "${clip(name, 60)}"` : role;
}

function layerName(layer: any): string {
  const kind = layer?.kind || 'layer';
  if (!layer?.name) return `${/^[aeiou]/i.test(kind) ? 'an' : 'a'} ${kind}`;
  return `${kind} "${clip(layer.name, 60)}"`;
}

// What an element reads as (its label, a newline, then its text): the head is
// its label, else its text.
function headOf(reads: string): string {
  const nl = reads.indexOf('\n');
  const label = (nl >= 0 ? reads.slice(0, nl) : reads).trim();
  const text = nl >= 0 ? reads.slice(nl + 1).trim() : '';
  const head = label || text;
  return head.length > 60 ? head.slice(0, 59) + '…' : head;
}

const squash = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// Whether it still reads as listed, by NoDriver's rule: the same head, or one
// that only grew or shrank by whole words; an element read as nothing, then
// or now, gives nothing to judge by.
function stillReads(seen: Shown, now: string): boolean {
  if (!seen.reads) return readsAsNamed(seen, now);
  const was = squash(headOf(seen.reads));
  const is = squash(headOf(now));
  return !was || !is || was === is || is.startsWith(was + ' ') || was.startsWith(is + ' ');
}

function readsAsNamed(seen: Shown, now: string): boolean {
  let name = squash(seen.name);
  if (!name) return true;
  const cut = name.indexOf('…');
  if (cut > 0) name = name.slice(0, cut).trim();
  if (name.length > 40) name = name.slice(0, 40);
  const nl = now.indexOf('\n');
  const label = squash(nl >= 0 ? now.slice(0, nl) : now);
  const text = nl >= 0 ? squash(now.slice(nl + 1)) : '';
  if (!label && !text) return true;
  return label.includes(name) || text.includes(name) || (!!label && name.includes(label));
}

function assertNoDialog(tab: Tab): void {
  if (tab.dialog) {
    const d = tab.dialog;
    throw new ToolError(
      `A ${d.type} dialog is open: ${JSON.stringify(d.message)}. The page waits until it is answered; call dialog.`,
    );
  }
}

// Brings the element into view the way a person would (wheel, not a jump).
async function reveal(tab: Tab, t: Target): Promise<string | null> {
  const r = await withPointer(tab, (p) =>
    tab.send('Input.revealElement', { backendNodeId: t.backendNodeId, frameId: t.frameId, ...p }, 20_000),
  );
  if (r.pointerX !== undefined) tab.pointer = { x: r.pointerX, y: r.pointerY };
  switch (r.outcome) {
    case 'shown':
      return null;
    case 'covered':
      return `${t.label} cannot be reached: ${r.covering ?? 'something'} lies over it${r.coveringKind ? ` (${r.coveringKind})` : ''}.`;
    case 'blocked':
      return `${t.label} could not be scrolled into view.`;
    case 'gone':
      return `${t.label} left the page.`;
    default:
      return `${t.label} could not be shown (${r.outcome}).`;
  }
}

const MOVE_REFUSALS: Record<string, string> = {
  covered: 'something else would take the press',
  hidden: 'none of it shows',
  gone: 'it left the page',
  unreachable: 'the hand could not get onto it',
  interrupted: 'other pointer input came first',
  timeout: 'it took too long',
};

async function moveTo(tab: Tab, t: Target, end?: MoveEnd, modifiers = 0): Promise<any> {
  const once = () =>
    withPointer(tab, (p) =>
      tab.send(
        'Input.moveTo',
        { backendNodeId: t.backendNodeId, frameId: t.frameId, ...p, ...(end ? { end } : {}), modifiers },
        30_000,
      ),
    );
  let r = await once();
  // Re-aim once when something covered the landing (the page may have moved).
  if (r.outcome === 'covered') r = await once();
  if (r.x !== undefined) tab.pointer = { x: r.x, y: r.y };
  return r;
}

// How a move ends: a click, its press and release in one command. No tool
// sends a press without its release; a drag is Input.performDrag, whole.
interface MoveEnd {
  action: 'click';
  button?: string;
  clickCount?: number;
}

function refusal(verb: string, t: Target, r: any): string {
  const why = MOVE_REFUSALS[r.outcome] ?? r.outcome;
  const hit = r.hit ? ` (${r.hit}${r.hitKind ? `, ${r.hitKind}` : ''})` : '';
  return `Did not ${verb} ${t.label}: ${why}${hit}.${r.reason && !MOVE_REFUSALS[r.reason] ? ` ${r.reason}` : ''}`;
}

// --- points -------------------------------------------------------------

// A point of the view, in CSS pixels, for what has no element of its own to
// aim at: a place in text an editor draws itself (Google Docs' pages are one
// canvas each), or a spot in a drawing.
export interface Point {
  x: number;
  y: number;
}

async function viewSize(tab: Tab): Promise<{ width: number; height: number }> {
  if (!tab.viewport) await viewCentre(tab);
  return tab.viewport!;
}

async function checkPoint(tab: Tab, p: Point): Promise<void> {
  const v = await viewSize(tab);
  if (!(p.x >= 0 && p.y >= 0 && p.x < v.width && p.y < v.height)) {
    throw new ToolError(`(${p.x}, ${p.y}) is outside the view (${v.width}x${v.height}); scroll first, or aim inside it.`);
  }
}

// No hit check: whatever is at the point takes the press, as with a person's
// hand. The browser answers unreachable for a point outside the view.
async function moveToPoint(tab: Tab, p: Point, end?: MoveEnd, modifiers = 0): Promise<any> {
  const r = await withPointer(tab, (pp) =>
    tab.send('Input.moveTo', { x: p.x, y: p.y, ...pp, ...(end ? { end } : {}), modifiers }, 30_000),
  );
  if (r.x !== undefined) tab.pointer = { x: r.x, y: r.y };
  return r;
}

const at = (p: Point) => `(${Math.round(p.x * 10) / 10}, ${Math.round(p.y * 10) / 10})`;

function pointRefusal(verb: string, p: Point, r: any): string {
  const why = r.outcome === 'unreachable' ? 'the hand could not get there' : MOVE_REFUSALS[r.outcome] ?? r.outcome;
  return `Did not ${verb} ${at(p)}: ${why}${r.reason && !MOVE_REFUSALS[r.reason] ? ` (${r.reason})` : ''}.`;
}

// --- when the first change lands ----------------------------------------

// not_before: an ISO 8601 time with its zone (Z or an offset), or epoch ms.
// The input that changes the page waits for it; moving the pointer or the
// caret before it does not. A longer wait than this is the caller's to make.
const LONGEST_WAIT_MS = 15 * 60_000;

export function parseNotBefore(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 1e12) throw new ToolError(`not_before ${v} is not a time in epoch milliseconds.`);
    return v;
  }
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(v.trim())) {
    throw new ToolError(`not_before "${v}" has no time zone: end it with Z (UTC) or an offset such as +01:00.`);
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new ToolError(`not_before "${v}" is not a time ISO 8601 can read.`);
  return t;
}

// Refused before anything moves: a wait longer than this is the caller's.
function checkNotBefore(t: number | undefined): void {
  if (t === undefined) return;
  const ms = t - Date.now();
  if (ms > LONGEST_WAIT_MS) {
    throw new ToolError(`not_before is ${Math.round(ms / 1000)} s away; this waits at most ${LONGEST_WAIT_MS / 60_000} minutes. Nothing was done. Call again nearer the time.`);
  }
}

class Cancelled extends Error {}

// A pause that ends early, with Cancelled, when the request is cancelled.
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Cancelled());
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(new Cancelled());
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

// A timer can fire a millisecond or two early, so the clock is read again
// until it is past the time.
async function waitUntil(t: number | undefined, signal?: AbortSignal): Promise<void> {
  if (t === undefined) return;
  try {
    for (let ms = t - Date.now(); ms > 0; ms = t - Date.now()) await pause(ms, signal);
  } catch (e) {
    if (e instanceof Cancelled) throw new ToolError('Cancelled while waiting for not_before; no key was sent.');
    throw e;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

// When the input ran, for a caller keeping to a schedule: from just before the
// first command went out to its answer (which comes once the last key is up).
function timesLine(notBefore: number | undefined, began: number, ended: number): string {
  const late = notBefore === undefined ? '' : began - notBefore > 50 ? `, ${began - notBefore} ms after not_before` : ', at not_before';
  return `Ran from ${iso(began)}${late} to ${iso(ended)} (${ended - began} ms).`;
}

// --- focus --------------------------------------------------------------

// Whether keys would go to this element now: the innermost focused element
// of the page, read in an isolated world the page cannot see, through open
// shadow roots and into frames of its own process (Docs takes keys in a
// same-origin frame's editable). A closed shadow root cannot be entered from
// script: the innermost element reachable is then its host, so a refusal
// names what has the focus, which shows such a case.
//
// The world is asked for again before each read: createIsolatedWorld with a
// worldName gives the same world again while the document lives
// (dom_wrapper_world.cc, EnsureInspectorIsolatedWorldWithName) and a new one
// in a new document, so no context id is kept to go stale (context ids start
// again in a new renderer process).
async function worldOf(tab: Tab): Promise<number> {
  const w = await onActivePage(() => tab.send('Page.createIsolatedWorld', { frameId: tab.targetId, worldName: 'chromaphore' }));
  return w.executionContextId as number;
}

// Run on the element named by expect_focus (`this`). An editor whose
// editable is a frame's <body> (designMode, or a contenteditable body) has
// the focus on that body, and the frame element itself counts as having it.
const FOCUS_CHECK = `function () {
  const target = this;
  let e = document.activeElement;
  let frame = null;
  for (let i = 0; i < 32 && e; i++) {
    if (e.shadowRoot && e.shadowRoot.activeElement) { e = e.shadowRoot.activeElement; continue; }
    let inner = null;
    try { inner = e.contentDocument; } catch (x) {}
    if (!inner || !inner.activeElement) break;
    const a = inner.activeElement;
    if (a === inner.body) {
      if (a && (a.isContentEditable || inner.designMode === 'on')) { frame = e; e = a; }
      break;
    }
    e = a;
  }
  const has = !!e && (e === target || (frame !== null && frame === target));
  const clip = (s) => { s = String(s).replace(/\\s+/g, ' ').trim(); return s.length > 50 ? s.slice(0, 49) + '…' : s; };
  let what = 'nothing';
  if (e && e === document.body) what = 'nothing (the page itself)';
  else if (e) {
    what = e.tagName.toLowerCase();
    const role = e.getAttribute('role');
    const label = e.getAttribute('aria-label');
    if (role) what += ' role=' + clip(role);
    if (label) what += ' "' + clip(label) + '"';
    if (e.id) what += ' #' + clip(e.id);
    if (frame) what += ' (the editable body of a frame)';
  }
  return { has, what };
}`;

interface FocusTarget {
  id: string;
  t: Target;
}

// Resolved before anything is sent, so a bad id fails at once, and again
// right before the focus check (focusRefusal). A newer browser reads the
// focus itself, in any frame (browserFocus).
async function focusTarget(tab: Tab, id: string | undefined): Promise<FocusTarget | null> {
  if (!id) return null;
  const t = await resolve(tab, id);
  if (t.frameId !== tab.targetId && !tab.browser.modern) {
    throw new ToolError(
      `${id} is in a frame of another site, where expect_focus cannot check the focus. Nothing was done. Leave expect_focus out to send the keys unchecked.`,
    );
  }
  return { id, t };
}

// Right before the keys: the id is resolved again (a wait for not_before can
// last 15 minutes, and the element of the early resolve may have gone since),
// then the focus is read.
async function focusRefusal(tab: Tab, ft: FocusTarget | null): Promise<string | null> {
  if (!ft) return null;
  let now: FocusTarget;
  try {
    now = (await focusTarget(tab, ft.id))!;
  } catch (e) {
    if (e instanceof ToolError) return `Nothing sent: ${e.message.replace(/ ?Nothing was done\./, '')}`;
    throw e;
  }
  const contextId = await worldOf(tab);
  let objectId: string | undefined;
  try {
    const node = await tab
      .send('DOM.resolveNode', { backendNodeId: now.t.backendNodeId, executionContextId: contextId })
      .catch(() => null);
    objectId = node?.object?.objectId;
    // resolve has just found it alive: the check's world cannot reach it, as
    // for an element in a frame of another origin in the same process
    // (resolve_node.cc gives no object across origins).
    if (!objectId) {
      return `Nothing sent: the focus check cannot read the frame ${ft.id} is in (such as a frame of another origin). Leave expect_focus out to send the keys unchecked.`;
    }
    const r = await tab.send('Runtime.callFunctionOn', { objectId, functionDeclaration: FOCUS_CHECK, returnByValue: true });
    if (r.exceptionDetails) throw new ToolError(`The focus check failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    const v = r.result?.value ?? {};
    if (v.has) return null;
    return `Nothing sent: ${ft.id} does not have the keyboard focus; ${v.what ?? 'something else'} has it (a box that opened can take it). Call observe to see the page.`;
  } finally {
    if (objectId) tab.send('Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

// A field as dispatchKeystrokes' expectField takes it: the field's own frame,
// as Input.readFocusedField names it. Page.resolveAgentNode names the local
// root instead, which expectField refuses for a field in a frame of the same
// process (measured 2026-11-17: "the focus is on backendNodeId 37 in frame
// BD73…, not on the field expected" for that very node).
interface FieldTarget {
  backendNodeId: number;
  frameId: string;
}

// What the focus check found: a refusal, or that the keys may go, with the
// field for the browser to keep watching (none for an editable frame body,
// which the browser reads as no field; see browserFocus).
interface FocusCheck {
  refused: string | null;
  field?: FieldTarget;
}

async function checkFocus(tab: Tab, ft: FocusTarget | null): Promise<FocusCheck> {
  if (!ft || !tab.browser.modern) return { refused: await focusRefusal(tab, ft) };
  return browserFocus(tab, ft);
}

// The ids of the frames a local root's renderer holds (a field's own frame
// and the local root its backend node id belongs to): from the tab's own
// session for the tab's main frame, else from a session of that frame's own.
async function framesOf(tab: Tab, localRoot: string): Promise<string[]> {
  const tree = await withSession(tab, localRoot, (send) => send('Page.getFrameTree'));
  const ids: string[] = [];
  const walk = (n: any) => {
    ids.push(n.frame.id);
    for (const c of n.childFrames ?? []) walk(c);
  };
  if (tree) walk(tree.frameTree);
  return ids;
}

// Runs `fn` on the session that can resolve the frame's backend node ids:
// the tab's, or one attached to the frame's own target (a frame of another
// process) for the call; null when there is none.
async function withSession<T>(tab: Tab, frameId: string, fn: (send: (m: string, p?: object) => Promise<any>) => Promise<T>): Promise<T | null> {
  if (frameId === tab.targetId) return fn((m, p = {}) => tab.send(m, p));
  const conn = tab.browser.conn;
  let sessionId: string;
  try {
    ({ sessionId } = await conn.send('Target.attachToTarget', { targetId: frameId, flatten: true }));
  } catch {
    return null;
  }
  try {
    return await fn((m, p = {}) => conn.send(m, p, sessionId, 10_000));
  } finally {
    conn.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

// What has the focus, in the words the script check uses (input "Main field"
// #main): the node described by the session of the renderer that holds it.
// A backend node id described on another renderer's session names another
// node (measured: a field of a frame of another site, id 1, came back as the
// main document), so the session is chosen by the field's frame.
async function focusedWords(tab: Tab, field: any): Promise<string> {
  if (field.kind === 'none') return 'nothing (the page itself)';
  const fallback = field.what ?? `a field (${field.kind}) in another frame`;
  try {
    const own = (await framesOf(tab, tab.targetId)).includes(field.frameId);
    const node = await withSession(tab, own ? tab.targetId : field.frameId, (send) =>
      send('DOM.describeNode', { backendNodeId: field.backendNodeId }).then((r: any) => r.node),
    );
    if (!node?.nodeName) return fallback;
    const attrs = new Map<string, string>();
    for (let i = 0; i + 1 < (node.attributes ?? []).length; i += 2) attrs.set(node.attributes[i], node.attributes[i + 1]);
    const c = (v: string) => clip(v, 50);
    let what = String(node.localName || node.nodeName).toLowerCase();
    if (attrs.get('role')) what += ` role=${c(attrs.get('role')!)}`;
    if (attrs.get('aria-label')) what += ` "${c(attrs.get('aria-label')!)}"`;
    if (attrs.get('id')) what += ` #${c(attrs.get('id')!)}`;
    return what;
  } catch {
    return fallback;
  }
}

// The focus check of a browser newer than release 2.0.0: its own reading of
// the focused field (Input.readFocusedField), in any frame and inside closed
// shadow roots, compared with the element. A backend node id is one renderer's,
// so the field must also be in a frame of the element's local root. A
// focused editable <body> of a frame (designMode, a contenteditable body)
// reads as no field at all ("none"), so then the script check runs, as on an
// older browser, and the keys go out unwatched (docs/DESIGN.md).
async function browserFocus(tab: Tab, ft: FocusTarget): Promise<FocusCheck> {
  let now: FocusTarget;
  try {
    now = (await focusTarget(tab, ft.id))!;
  } catch (e) {
    if (e instanceof ToolError) return { refused: `Nothing sent: ${e.message.replace(/ ?Nothing was done\./, '')}` };
    throw e;
  }
  const field = (await tab.send('Input.readFocusedField', {}, 10_000)).field;
  if (!field) return { refused: `Nothing sent: the frame that has the focus did not answer the focus check in time. Try again.` };
  if (field.kind === 'none' && now.t.frameId === tab.targetId) return { refused: await focusRefusal(tab, now) };
  if (field.backendNodeId === now.t.backendNodeId && field.frameId) {
    const same = field.frameId === now.t.frameId || (await framesOf(tab, now.t.frameId)).includes(field.frameId);
    if (same) return { refused: null, field: { backendNodeId: field.backendNodeId, frameId: field.frameId } };
  }
  return {
    refused: `Nothing sent: ${ft.id} does not have the keyboard focus; ${await focusedWords(tab, field)} has it (a box that opened can take it). Call observe to see the page.`,
  };
}

const MODIFIERS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };

function modifierBits(names: string[] = []): number {
  return names.reduce((bits, n) => {
    const b = MODIFIERS[n.toLowerCase()];
    if (b === undefined) throw new ToolError(`Unknown modifier "${n}". Use Alt, Ctrl, Meta or Shift.`);
    return bits | b;
  }, 0);
}

// --- tools --------------------------------------------------------------

export async function click(
  tab: Tab,
  id: string,
  opts: { button?: string; count?: number; modifiers?: string[]; quiet?: boolean } = {},
): Promise<string> {
  assertNoDialog(tab);
  const t = await resolve(tab, id);
  const hidden = await reveal(tab, t);
  if (hidden) return `Not clicked. ${hidden}`;
  const end: MoveEnd = { action: 'click', button: opts.button ?? 'left', clickCount: opts.count ?? 1 };
  const r = await moveTo(tab, t, end, modifierBits(opts.modifiers));
  if (r.outcome !== 'clicked') return refusal('click', t, r);
  const landed = r.hit ? ` (the press landed on ${r.hit})` : '';
  return afterAction(tab, [`Clicked ${id}${landed}.`], r.actionOutcome, opts.quiet);
}

// A click at a point of the view, where no element can be aimed at: in text an
// editor draws itself, a click between two characters puts the caret there.
export async function clickAt(
  tab: Tab,
  p: Point,
  opts: { button?: string; count?: number; modifiers?: string[]; quiet?: boolean } = {},
): Promise<string> {
  assertNoDialog(tab);
  await checkPoint(tab, p);
  const end: MoveEnd = { action: 'click', button: opts.button ?? 'left', clickCount: opts.count ?? 1 };
  const r = await moveToPoint(tab, p, end, modifierBits(opts.modifiers));
  if (r.outcome !== 'clicked') return pointRefusal('click at', p, r);
  const times = (opts.count ?? 1) > 1 ? ` ${opts.count} times` : '';
  return afterAction(tab, [`Clicked at ${at(p)}${times}.`], r.actionOutcome, opts.quiet);
}

export async function hover(tab: Tab, id: string): Promise<string> {
  assertNoDialog(tab);
  const t = await resolve(tab, id);
  const hidden = await reveal(tab, t);
  if (hidden) return `Not hovered. ${hidden}`;
  const r = await moveTo(tab, t);
  if (r.outcome !== 'arrived') return refusal('hover over', t, r);
  return afterAction(tab, [`The pointer is on ${id}.`]);
}

export async function hoverAt(tab: Tab, p: Point): Promise<string> {
  assertNoDialog(tab);
  await checkPoint(tab, p);
  const r = await moveToPoint(tab, p);
  if (r.outcome !== 'arrived') return pointRefusal('move to', p, r);
  return afterAction(tab, [`The pointer is at ${at(p)}.`]);
}

// --- aiming by text (a browser newer than release 2.0.0) -----------------

// A place in the canvas text in view: where text_before ends and text_after
// begins (canvas.ts, aim). Everything that can be refused is, before the
// pointer moves.
export interface TextPlace {
  before?: string;
  after?: string;
}

// The caller's text, quoted as given (whitespace as one space), cut long.
function quoted(s: string): string {
  const t = normalise(s);
  return JSON.stringify(t.length > 60 ? t.slice(0, 59) + '…' : t);
}

function placeWords(p: TextPlace): string {
  if (p.before !== undefined && p.after !== undefined) return `between ${quoted(p.before)} and ${quoted(p.after)}`;
  return p.before !== undefined ? `after ${quoted(p.before)}` : `before ${quoted(p.after!)}`;
}

// The texts given, in order, for a refusal: "Plain " then "“quotes”".
function textsWords(...parts: (string | undefined)[]): string {
  return parts.filter((x): x is string => x !== undefined).map(quoted).join(' then ');
}

async function aimAt(tab: Tab, before: string | undefined, middle: string | undefined, after: string | undefined, feature: string) {
  if (!tab.browser.modern) throw new ToolError(predates(feature));
  const lines = linesOf(await readCanvas(tab));
  const aims = aim(lines, before, middle, after, textsWords(before, middle, after));
  for (const a of aims) await checkPoint(tab, a.point);
  return { points: aims.map((a) => a.point), caution: caution(aims) };
}

export async function clickText(
  tab: Tab,
  place: TextPlace,
  opts: { button?: string; count?: number; modifiers?: string[]; quiet?: boolean } = {},
): Promise<string> {
  assertNoDialog(tab);
  const words = placeWords(place);
  const { points, caution } = await aimAt(tab, place.before, undefined, place.after, 'aiming by text');
  const p = points[0];
  const end: MoveEnd = { action: 'click', button: opts.button ?? 'left', clickCount: opts.count ?? 1 };
  const r = await moveToPoint(tab, p, end, modifierBits(opts.modifiers));
  if (r.outcome !== 'clicked') return pointRefusal(`click ${words} at`, p, r);
  const times = (opts.count ?? 1) > 1 ? ` ${opts.count} times` : '';
  return afterAction(tab, [`Clicked ${words} at ${at(p)}${times}.`, ...(caution ? [caution] : [])], r.actionOutcome, opts.quiet);
}

export async function hoverText(tab: Tab, place: TextPlace): Promise<string> {
  assertNoDialog(tab);
  const words = placeWords(place);
  const { points, caution } = await aimAt(tab, place.before, undefined, place.after, 'aiming by text');
  const r = await moveToPoint(tab, points[0]);
  if (r.outcome !== 'arrived') return pointRefusal(`move ${words} at`, points[0], r);
  return afterAction(tab, [`The pointer is ${words} at ${at(points[0])}.`, ...(caution ? [caution] : [])]);
}

// When a drag answers that its own button is still down (buttonDown), the
// button is let go where the pointer is, and the answer says so.
async function releaseIfDown(tab: Tab, r: any): Promise<string | null> {
  if (!r.buttonDown) return null;
  const p = tab.pointer ?? (await viewCentre(tab));
  try {
    const u = await withPointer(tab, (pp) => tab.send('Input.moveTo', { x: p.x, y: p.y, ...pp, end: { action: 'release' } }, 30_000));
    if (u.x !== undefined) tab.pointer = { x: u.x, y: u.y };
    return `The drag ended with its button still down; it was let go at ${at(p)}.`;
  } catch (e) {
    const why = e instanceof CdpError ? e.message : e instanceof Error ? e.message : String(e);
    return `The drag ended with its button still down, and letting it go failed: ${why}`;
  }
}

// --- the browser's own clipboard (a browser newer than release 2.0.0) ----

const MAX_CLIP_TEXT = 40_000;
const MAX_CLIP_HTML = 20_000;

export async function clipboard(tab: Tab, opts: { set?: string; html?: boolean }): Promise<string> {
  if (!tab.browser.modern) throw new ToolError(predates("reading or setting its own clipboard"));
  const lines: string[] = [];
  if (opts.set !== undefined) {
    await tab.send('Input.writeClipboard', { text: opts.set });
    lines.push(`Put ${opts.set.length} character(s) on the browser's clipboard (nothing was pasted).`);
  }
  const r = await tab.send('Input.readClipboard');
  // The browser stores CRLF on Windows for its own pastes and a page's copy.
  const text = String(r.text ?? '').replace(/\r\n?/g, '\n');
  if (!text) lines.push('The clipboard holds no text.');
  else {
    const shown = text.length > MAX_CLIP_TEXT ? `${text.slice(0, MAX_CLIP_TEXT)}` : text;
    lines.push(`The clipboard holds ${text.length} character(s) of text, line breaks as \\n:`, JSON.stringify(shown) + (shown.length < text.length ? ` … (${text.length - shown.length} more characters)` : ''));
  }
  if (r.html !== undefined && r.html !== null) {
    lines.push(`It also holds HTML (${r.html.length} characters)${opts.html ? ':' : '; html: true shows it.'}`);
    if (opts.html) lines.push(r.html.length > MAX_CLIP_HTML ? `${r.html.slice(0, MAX_CLIP_HTML)}\n… (cut at ${MAX_CLIP_HTML} of ${r.html.length} characters)` : r.html);
  } else lines.push('It holds no HTML.');
  return lines.join('\n');
}

// Human typing: 60-260 ms between keys, a thinking pause now and
// then, and a rare typo, corrected at once, except where a wrong character
// costs something.
const NO_TYPOS = {
  inputTypes: ['password', 'number', 'tel', 'date', 'time', 'datetime-local', 'month', 'week', 'email', 'url'],
  autocompleteTokens: ['one-time-code'],
  autocompletePrefixes: ['cc-'],
  inputModes: ['numeric', 'decimal', 'tel'],
  maxLengthAtMost: 6,
};

// A burst as a person types it: text, Backspaces, pauses and shortcuts (a
// formatting toggle) in the order given.
export type KeyStep = string | { bs: number } | { pause_ms: number } | { press: string };

// A burst's steps, every press parsed, before anything is sent.
export type Step =
  | { kind: 'text'; text: string }
  | { kind: 'bs'; n: number }
  | { kind: 'pause'; ms: number }
  | { kind: 'press'; label: string; modifiers: number; key: string };

export function planBurst(keys: KeyStep[]): Step[] {
  return keys.map((k, i): Step => {
    if (typeof k === 'string') return { kind: 'text', text: k };
    if ('bs' in k) return { kind: 'bs', n: k.bs };
    if ('pause_ms' in k) return { kind: 'pause', ms: k.pause_ms };
    try {
      return { kind: 'press', label: k.press, ...chordOf(k.press) };
    } catch (e) {
      throw new ToolError(`Nothing typed: step ${i + 1} of keys, {"press": ${JSON.stringify(k.press)}}: ${(e as Error).message}`);
    }
  });
}

const ALT = 1;
const CTRL = 2;
const META = 4;
// Plain keys the text check counts as what they type.
const TYPES_AS: Record<string, string> = { Enter: '\n', Tab: '\t', Space: ' ' };
// With Ctrl or Meta, keys whose effect on the text the check cannot follow:
// select all, paste, cut, undo, redo, word deletes, a line break, moves.
const UNFOLLOWED_WITH_CTRL = new Set([
  'a', 'v', 'x', 'z', 'y', 'Backspace', 'Delete', 'Enter',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End',
]);

// Whether the text check cannot follow what this press does to the text: any
// press without Ctrl, Alt or Meta that does not type (a move, Delete,
// Escape...), and the Ctrl or Meta chords above. Other chords (a formatting
// toggle such as Ctrl+I) are trusted to leave the text as it is.
function unfollowed(s: Step & { kind: 'press' }): boolean {
  if (!(s.modifiers & (CTRL | ALT | META))) return !(s.modifiers === 0 && (s.key in TYPES_AS || s.key === 'Backspace'));
  return !!(s.modifiers & (CTRL | META)) && UNFOLLOWED_WITH_CTRL.has(s.key);
}

// What a burst leaves: its strings and the plain Enter, Tab and Space it
// presses, less what its Backspaces take back. A Backspace past the burst's
// start deletes text that was there before (reachesBack); `unfollowed` names
// the presses whose effect the check cannot know.
export function burstText(steps: Step[]): { text: string; reachesBack: number; unfollowed: string[] } {
  let text = '';
  let reachesBack = 0;
  const blind: string[] = [];
  const back = (count: number) => {
    const chars = [...text];
    const n = Math.min(count, chars.length);
    text = chars.slice(0, chars.length - n).join('');
    reachesBack += count - n;
  };
  for (const s of steps) {
    if (s.kind === 'text') text += s.text;
    else if (s.kind === 'bs') back(s.n);
    else if (s.kind === 'press') {
      if (unfollowed(s)) blind.push(s.label);
      else if (s.modifiers === 0 && s.key in TYPES_AS) text += TYPES_AS[s.key];
      else if (s.modifiers === 0 && s.key === 'Backspace') back(1);
    }
  }
  return { text, reachesBack, unfollowed: blind };
}

// Text as typed, cut short: unlike clip, newlines and tabs are kept (JSON
// shows them as \n and \t), since they are keys the burst presses.
function cut(s: string, max = 120): string {
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s;
}

// The refusal of a burst whose text check fails, or null.
export function textCheck(steps: Step[], text: string): string | null {
  const left = burstText(steps);
  if (left.unfollowed.length) {
    const named = left.unfollowed.map((p) => `{"press": ${JSON.stringify(p)}}`).join(', ');
    return `Nothing typed: with text given, the check cannot follow what ${named} does to the text. Leave text out to play the burst unchecked.`;
  }
  if (left.text !== text || left.reachesBack) {
    return `Nothing typed: keys leave ${JSON.stringify(cut(left.text))}${left.reachesBack ? ` and delete ${left.reachesBack} character(s) from before the burst` : ''}, not text ${JSON.stringify(cut(text))}.`;
  }
  return null;
}

function stepWords(s: Step): string {
  switch (s.kind) {
    case 'text':
      return JSON.stringify(cut(s.text, 40));
    case 'bs':
      return `{"bs": ${s.n}}`;
    case 'pause':
      return `{"pause_ms": ${s.ms}}`;
    case 'press':
      return `{"press": ${JSON.stringify(s.label)}}`;
  }
}

export interface TypeOptions {
  id?: string;
  text?: string;
  keys?: KeyStep[];
  clear?: boolean;
  submit?: boolean;
  exact?: boolean;
  seed?: number;
  speed?: number;
  notBefore?: number;
  expectFocus?: string;
  quiet?: boolean;
  signal?: AbortSignal;
  // Replay options (server.ts lets them through only with the setting on).
  dryRun?: boolean;
  keyLog?: string;
  // The setting is on: the answer says the seed the browser used.
  replay?: boolean;
}

// The gap a person leaves between two steps of a burst (a word, then a
// Backspace, then a shortcut), on top of the lead the browser gives each key
// press (measured: letters 120-370 ms apart, a chord after a word about
// 300 ms).
function keyGap(rand: () => number, speed: number): number {
  return Math.round((40 + rand() * 120) / speed);
}

// The finaliser of MurmurHash3: a bijection of 32 bits in which every bit
// of the input moves about half the bits of the output.
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// A small seeded generator, so one seed gives one burst. The whole seed (up
// to 2^47) is mixed into the state, so small and neighbouring seeds start
// from unrelated states rather than near zero.
export function seeded(seed: number): () => number {
  const lo = seed >>> 0;
  const hi = Math.floor(seed / 2 ** 32) >>> 0;
  let s = fmix32(fmix32(lo ^ 0x9e3779b9) ^ hi ^ 0x7f4a7c15) || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

// A cancelled request stops sending: what is under way finishes (a string
// being typed runs to its end, docs/DESIGN.md), nothing after it goes out.
function cancelledLine(signal: AbortSignal | undefined, what: string): string | null {
  return signal?.aborted ? `Stopped on request: ${what}.` : null;
}

// Clicks into an element before keys or a paste. Answers a refusal, or null.
async function clickInto(tab: Tab, id: string, verb: string): Promise<string | null> {
  const t = await resolve(tab, id);
  const hidden = await reveal(tab, t);
  if (hidden) return `${verb} ${hidden}`;
  const r = await moveTo(tab, t, { action: 'click' });
  if (r.outcome !== 'clicked') return refusal('click into', t, r);
  return null;
}

export async function type(tab: Tab, opts: TypeOptions): Promise<string> {
  assertNoDialog(tab);
  if (opts.text === undefined && !opts.keys) throw new ToolError('Give text, or keys.');
  if (opts.keys && opts.exact === false) throw new ToolError('keys are played as given, with no typos of the tool\'s own; leave exact out.');
  // Everything that can be refused is, before anything moves.
  if ((opts.dryRun || opts.keyLog !== undefined) && !tab.browser.modern) {
    throw new ToolError(predates(opts.dryRun ? 'planning keys without sending them (dry_run)' : 'logging the key events (key_log)'));
  }
  if (opts.dryRun) {
    const given = (
      [['id', opts.id], ['clear', opts.clear], ['submit', opts.submit], ['not_before', opts.notBefore], ['expect_focus', opts.expectFocus]] as const
    ).filter(([, v]) => v !== undefined && v !== false).map(([k]) => k);
    if (given.length) {
      throw new ToolError(`dry_run sends nothing and waits for nothing, so ${given.join(', ')} cannot go with it. Nothing was done.`);
    }
  }
  checkNotBefore(opts.notBefore);
  const plan = opts.keys ? planBurst(opts.keys) : null;
  if (plan && opts.text !== undefined) {
    const refused = textCheck(plan, opts.text);
    if (refused) return refused;
  }
  if (opts.dryRun) return planOnly(tab, { plan, text: opts.text, exact: opts.exact, seed: opts.seed, speed: opts.speed ?? 1, keyLog: opts.keyLog });
  const ft = await focusTarget(tab, opts.expectFocus);
  const signal = opts.signal;
  const speed = opts.speed ?? 1;
  const said: string[] = [];
  if (opts.id) {
    const refused = await clickInto(tab, opts.id, 'Nothing typed.');
    if (refused) return refused;
  }
  // Placing the caret comes before the time; the first key waits for it.
  await waitUntil(opts.notBefore, signal);
  assertNoDialog(tab);
  const focus = await checkFocus(tab, ft);
  if (focus.refused) return [...said, focus.refused].join('\n');
  const stopped = cancelledLine(signal, 'no key was sent');
  if (stopped) return stopped;
  const began = Date.now();
  let outcome: any;
  const chord = async (key: string, modifiers = 0, pace = speed) => {
    const r = await tab.send('Input.dispatchKeyChord', { modifiers, key, speedMultiplier: pace });
    outcome = r.actionOutcome ?? outcome;
  };
  if (opts.clear) {
    await chord('a', CTRL);
    if (!opts.text && !opts.keys && !signal?.aborted) await chord('Delete');
  }
  if (tab.browser.modern && (plan || opts.text)) {
    if (signal?.aborted) return 'Stopped on request: nothing was typed.';
    const timeline = opts.notBefore !== undefined || opts.keyLog !== undefined || !!opts.replay;
    const m = await typeInBrowser(tab, { plan, text: opts.text, exact: opts.exact, seed: opts.seed, speed, signal, field: focus.field, ft, into: opts.id, timeline, replay: opts.replay });
    if (m.refused) return [...said, m.refused].join('\n');
    const logged = opts.keyLog !== undefined && m.r ? appendKeyLog(opts.keyLog, m.r, false) : null;
    if (m.cancelled) return [m.cancelled, ...(logged ? [logged] : [])].join('\n');
    outcome = m.outcome ?? outcome;
    said.push(...m.said);
    if (opts.submit && !m.stopped) {
      await chord('Enter');
      said.push('Pressed Enter.');
    }
    if (opts.notBefore !== undefined || opts.keyLog !== undefined) {
      said.push(keyTimesLine(opts.notBefore, m.r) ?? timesLine(opts.notBefore, began, Date.now()));
    }
    if (logged) said.push(logged);
    if (m.stopped) return keepAccount(said, () => afterAction(tab, said, outcome, opts.quiet));
    return afterAction(tab, said, outcome, opts.quiet);
  }
  const seed = opts.seed ?? randomInt(0, 2 ** 47);
  const keystrokes = async (text: string, typos: number, part: number, readBack: boolean) => {
    const r = await tab.send(
      'Input.dispatchKeystrokes',
      {
        text,
        keystrokeDelayMin: 60,
        keystrokeDelayMax: 260,
        speedMultiplier: speed,
        thinkingPauseProbability: 0.02,
        thinkingPauseMin: 300,
        thinkingPauseMax: 800,
        typoProbability: typos,
        ...(typos ? { noTypos: NO_TYPOS } : {}),
        seed: seed + part,
        readBack,
      },
      30_000 + (text.length * 1_000) / Math.min(speed, 1),
    );
    outcome = r.actionOutcome ?? outcome;
    return r;
  };
  let failed = false;
  if (plan) {
    const r = await playBurst(plan, { speed, seed, signal, keystrokes, chord });
    if (r.cancelled) return `Stopped on request before step ${r.at + 1} of ${plan.length}; before it went out ${r.counts}.`;
    if (r.failed) {
      failed = true;
      said.push(`The burst stopped at step ${r.at + 1} of ${plan.length} (${stepWords(plan[r.at])}): ${r.failed}. Before it went out ${r.counts}; nothing after it.`);
    } else {
      const left = burstText(plan);
      const where = r.last?.fieldBefore?.kind === 'none' ? ' (nothing had focus: the keys went to the page)' : '';
      const leaves = left.unfollowed.length
        ? ''
        : `; it leaves ${JSON.stringify(cut(left.text))}${left.reachesBack ? ` and deletes ${left.reachesBack} character(s) from before it` : ''}`;
      said.push(`Typed the burst${opts.id ? ` into ${opts.id}` : ''}: ${r.counts}${where}${leaves}.`);
      if (r.last?.fieldAfter?.moved) said.push('Focus moved on by itself after the keys.');
    }
  } else if (opts.text) {
    if (signal?.aborted) return 'Stopped on request: nothing was typed.';
    const r = await keystrokes(opts.text, opts.exact ? 0 : 0.015, 0, true);
    const where = r.fieldBefore?.kind === 'none' ? ' (nothing had focus: the keys went to the page)' : '';
    const typoWords = r.typosCorrected ? `, making and correcting ${r.typosCorrected} typo(s)` : '';
    said.push(`Typed ${opts.text.length} character(s)${opts.id ? ` into ${opts.id}` : ''}${typoWords}${where}.`);
    if (r.fieldAfter?.moved) said.push('Focus moved on by itself after the keys.');
  } else if (opts.clear) {
    said.push(`Cleared ${opts.id ?? 'the focused field'}.`);
  }
  if (signal?.aborted) return 'Stopped on request after the keys under way; nothing after them was sent.';
  if (opts.submit && !failed) {
    await chord('Enter');
    said.push('Pressed Enter.');
  }
  if (opts.notBefore !== undefined) said.push(timesLine(opts.notBefore, began, Date.now()));
  if (failed) return keepAccount(said, () => afterAction(tab, said, outcome, opts.quiet));
  return afterAction(tab, said, outcome, opts.quiet);
}

// --- typing on a browser newer than release 2.0.0 --------------------------

// While a typing call runs, a cancelled request stops it: a chord call that
// presses nothing (Input.dispatchKeyChord with phase up) replaces the typing
// session under way, whose keys come up first (the browser's BR2; measured
// 2026-11-17 on a page logging keydown and keyup by code: none left down).
async function cancellable<T>(tab: Tab, signal: AbortSignal | undefined, call: Promise<T>): Promise<T> {
  if (!signal) return call;
  const stop = () => void tab.send('Input.dispatchKeyChord', { modifiers: 0, phase: 'up' }).catch(() => {});
  signal.addEventListener('abort', stop, { once: true });
  try {
    return await call;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

function countsOf(steps: Step[]): string {
  const n = { chars: 0, bs: 0, presses: 0, pauses: 0 };
  for (const s of steps) {
    if (s.kind === 'text') n.chars += [...s.text].length;
    else if (s.kind === 'bs') n.bs += s.n;
    else if (s.kind === 'press') n.presses++;
    else n.pauses++;
  }
  const parts = [`${n.chars} character(s)`];
  if (n.bs) parts.push(`${n.bs} Backspace(s)`);
  if (n.presses) parts.push(`${n.presses} key press(es)`);
  if (n.pauses) parts.push(`${n.pauses} pause(s)`);
  return parts.join(', ');
}

// What a watched call says beyond its keys: keys that may have reached
// another field, and focus that left and came back.
// `told`: uncertain keys a stop's account already named, left out here.
function watchLines(r: any, told?: Set<any>): string[] {
  const out: string[] = [];
  const all = (r.uncertainKeys ?? []).filter((k: any) => k.event === 'down');
  const keys = all.filter((k: any) => !told?.has(k)).map((k: any) => JSON.stringify(k.key));
  if (keys.length) out.push(`${told?.size ? 'Other keys' : 'Keys'} that may have reached the field that took the focus: ${keys.join(', ')}.`);
  else if (r.stopped === 'focus' && !all.length) out.push('No key was on its way when the focus moved.');
  if (r.focusResumes || r.slippedMs) {
    out.push(`The focus left and came back ${r.focusResumes ?? 0} time(s); the keys after it went out ${Math.round(r.slippedMs ?? 0)} ms later than planned.`);
  }
  return out;
}

// A string, or a whole burst, as one Input.dispatchKeystrokes call: the
// browser times every key, Backspace, shortcut and pause on one schedule
// (no gaps, Backspace pace or seeds of the plugin's own). With expect_focus
// the browser watches the field: it refuses before the first key unless the
// field has the focus, and stops when the focus leaves it.
async function typeInBrowser(
  tab: Tab,
  o: {
    plan: Step[] | null;
    text?: string;
    exact?: boolean;
    seed?: number;
    speed: number;
    signal?: AbortSignal;
    field?: FieldTarget;
    ft: FocusTarget | null;
    into?: string;
    // Ask for the timeline (not_before, key_log, the replay setting); a
    // watched call (field) asks for it too, for the account of a stop.
    timeline?: boolean;
    replay?: boolean;
  },
): Promise<{ said: string[]; outcome?: any; stopped?: boolean; refused?: string; cancelled?: string; r?: any }> {
  const { index, steps, params, budget } = keystrokesCall(o);
  Object.assign(params, {
    readBack: true,
    ...(o.timeline || o.field ? { timeline: true } : {}),
    ...(o.field ? { stopWhenFocusLeaves: true, expectField: o.field } : {}),
  });
  const stoppedWords = 'Stopped on request: the keys under way were cut short (every key down came up); nothing after them was sent.';
  let r: any;
  try {
    r = await cancellable(tab, o.signal, tab.send('Input.dispatchKeystrokes', params, budget));
  } catch (e) {
    if (o.signal?.aborted) return { said: [], cancelled: stoppedWords };
    // Refused before any key: the field had lost the focus since the check.
    if (e instanceof CdpError && /^(expectField|stopWhenFocusLeaves):/.test(e.message) && o.ft) {
      const again = await checkFocus(tab, o.ft);
      return { said: [], refused: again.refused ?? `Nothing sent: ${e.message}` };
    }
    throw e;
  }
  if (r.stopped && o.signal?.aborted) return { said: [], cancelled: stoppedWords, r };
  const said: string[] = [];
  const into = o.into ? ` into ${o.into}` : '';
  const who = o.ft?.id ?? 'the field';
  const seedLine = o.replay && typeof r.seed === 'number' ? [seedWords(r)] : [];
  if (r.stopped) {
    const why = r.stopped === 'focus' ? `the focus left ${who}` : 'other input cut it short';
    const step = o.plan ? (o.plan[index[r.stepsDone] ?? o.plan.length - 1]) : ({ kind: 'text', text: o.text ?? '' } as Step);
    const told = r.timeline ? stepAccount(r, step, who) : null;
    if (o.plan) {
      const at = index[r.stepsDone] ?? o.plan.length - 1;
      const part = told
        ? told.part ? `; of step ${at + 1} (${stepWords(o.plan[at])}), ${told.part}` : ''
        : r.charsSent ? `, and ${r.charsSent} character(s) of step ${at + 1} (${stepWords(o.plan[at])})` : '';
      said.push(`The burst stopped${into}: ${why}. ${r.stepsDone} of ${steps.length} step(s) went out whole${part}; nothing after.`);
    } else if (told) {
      said.push(`Typing stopped${into}: ${why} after ${told.part}; nothing after.`);
    } else {
      said.push(`Typing stopped${into}: ${why} after ${r.charsSent ?? 0} of ${(o.text ?? '').length} character(s); nothing after.`);
    }
    if (told?.uncertain) said.push(told.uncertain);
    if (r.inTypo) said.push('It stopped inside a typo, before its correction: a wrong character may stand in the field.');
    said.push(...watchLines(r, told ? told.listed : undefined), ...seedLine);
    return { said, outcome: r.actionOutcome, stopped: true, r };
  }
  const where = r.fieldBefore?.kind === 'none' ? ' (nothing had focus: the keys went to the page)' : '';
  if (o.plan) {
    const left = burstText(o.plan);
    const leaves = left.unfollowed.length
      ? ''
      : `; it leaves ${JSON.stringify(cut(left.text))}${left.reachesBack ? ` and deletes ${left.reachesBack} character(s) from before it` : ''}`;
    const span = typeof r.durationMs === 'number' ? ` (one schedule, ${(r.durationMs / 1000).toFixed(1)} s)` : '';
    said.push(`Typed the burst${into}${span}: ${countsOf(o.plan)}${where}${leaves}.`);
  } else {
    const typoWords = r.typosCorrected ? `, making and correcting ${r.typosCorrected} typo(s)` : '';
    said.push(`Typed ${(o.text ?? '').length} character(s)${into}${typoWords}${where}.`);
  }
  if (r.fieldAfter?.moved) said.push('Focus moved on by itself after the keys.');
  said.push(...watchLines(r), ...seedLine);
  return { said, outcome: r.actionOutcome, r };
}

// The parameters of an Input.dispatchKeystrokes call for a string or a burst,
// each browser step's place in the plan (an empty string is no step), and a
// time budget for the answer.
function keystrokesCall(o: { plan: Step[] | null; text?: string; exact?: boolean; seed?: number; speed: number }) {
  const index: number[] = [];
  const steps: object[] = [];
  o.plan?.forEach((s, i) => {
    if (s.kind === 'text' && !s.text) return;
    index.push(i);
    if (s.kind === 'text') steps.push({ text: s.text });
    else if (s.kind === 'bs') steps.push({ backspaces: s.n });
    else if (s.kind === 'pause') steps.push({ pauseMs: s.ms });
    else steps.push({ chord: { modifiers: s.modifiers, key: s.key } });
  });
  const typos = o.plan || o.exact ? 0 : 0.015;
  const params: Record<string, unknown> = {
    ...(o.plan ? { steps } : { text: o.text }),
    keystrokeDelayMin: 60,
    keystrokeDelayMax: 260,
    speedMultiplier: o.speed,
    thinkingPauseProbability: 0.02,
    thinkingPauseMin: 300,
    thinkingPauseMax: 800,
    typoProbability: typos,
    ...(typos ? { noTypos: NO_TYPOS } : {}),
    ...(o.seed !== undefined ? { seed: o.seed } : {}),
  };
  let budget = 30_000;
  for (const s of o.plan ?? [{ kind: 'text', text: o.text ?? '' } as Step]) {
    if (s.kind === 'text') budget += ([...s.text].length * 1_000) / Math.min(o.speed, 1);
    else if (s.kind === 'bs') budget += (s.n * 1_000) / Math.min(o.speed, 1);
    else if (s.kind === 'pause') budget += s.ms;
    else budget += 3_000;
  }
  return { index, steps, params, budget };
}

const typosWords = (r: any) => `typos ${r.typosAllowed ? 'allowed' : 'not allowed'}`;

// The seed the browser used (a call without seed draws one), for a caller
// who wants the same schedule again.
function seedWords(r: any): string {
  return `Seed ${r.seed} (${typosWords(r)}): pass it back as seed, with the same text or keys and speed, for the same schedule.`;
}

// A key event of a character of a step: its own key, not the Shift it went
// down under, nor a typo's.
const charKey = (step: number) => (e: any) => e.step === step && e.charIndex !== undefined && !e.typo && e.key !== 'Shift';

// What a stopped call did to the step under way, counted from the timeline:
// the characters (or Backspaces) whose key went down reached a field, the
// focused one or the one that took the focus; those the browser lists as
// uncertain may have gone to the latter. The keys stop's own charsSent
// counts only characters whose keys all came up, which a key down but not
// yet up has already typed (docs/DESIGN.md, "The account of a stop").
function stepAccount(r: any, step: Step, who: string): { part: string | null; uncertain: string | null; listed: Set<any> } {
  const cur = r.stepsDone ?? 0;
  const down = new Set((r.timeline ?? []).filter((e: any) => e.event === 'down' && charKey(cur)(e)).map((e: any) => e.charIndex));
  const unsure = (r.uncertainKeys ?? []).filter((e: any) => e.event === 'down' && charKey(cur)(e));
  const listed = new Set(unsure);
  const n = down.size;
  if (step.kind === 'bs') {
    return {
      part: `${n} of ${step.n} Backspace(s) went down`,
      uncertain: unsure.length ? `The browser lists ${unsure.length} of them as uncertain: they may have gone to the field that took the focus.` : null,
      listed,
    };
  }
  if (step.kind !== 'text') return { part: null, uncertain: null, listed: new Set() };
  const total = step.text.length;
  const chars = [...new Set<number>(unsure.map((e: any) => e.charIndex as number))].sort((a, b) => a - b);
  const part = `${n} of ${total} character(s) had their key go down (they reached a field)`;
  const uncertain = chars.length
    ? `Of them, the browser lists ${chars.length} as uncertain (${chars.map((i) => JSON.stringify(step.text[i] ?? '?')).join(', ')}): they may have gone to the field that took the focus, so ${who} holds between ${n - chars.length} and ${n} of them.`
    : n
      ? `The browser lists none of them as uncertain: all ${n} went to ${who}.`
      : null;
  return { part, uncertain, listed };
}

// The time line from the timeline the browser answered: when the first key
// went down and when the last came up, as stamped when sent; null without
// a timeline (the caller then says when the call ran).
function keyTimesLine(notBefore: number | undefined, r: any): string | null {
  const tl: any[] = r?.timeline ?? [];
  const downs = tl.filter((e) => e.event === 'down');
  const ups = tl.filter((e) => e.event === 'up');
  if (typeof r?.startEpochMs !== 'number' || !downs.length || !ups.length) return null;
  const first = r.startEpochMs + Math.min(...downs.map((e) => e.timeMs));
  const last = r.startEpochMs + Math.max(...ups.map((e) => e.timeMs));
  const late = notBefore === undefined ? '' : `, ${Math.round(first - notBefore)} ms after not_before`;
  return `Ran from ${iso(first)} (the first key down${late}) to ${iso(last)} (the last key up), ${Math.round(last - first)} ms.`;
}

// One JSON line per call, appended: the start, the seed, the plan's length,
// the typo decision and count, a stop, and the events as the browser gave
// them. A failure to write is a line of the answer, never its end.
function appendKeyLog(file: string, r: any, dryRun: boolean): string {
  const target = path.resolve(file);
  const events: any[] = r.timeline ?? [];
  const entry = {
    ...(dryRun ? { dryRun: true } : {}),
    start: typeof r.startEpochMs === 'number' ? new Date(r.startEpochMs).toISOString() : null,
    startEpochMs: r.startEpochMs ?? null,
    seed: r.seed ?? null,
    durationMs: r.durationMs ?? null,
    typosAllowed: r.typosAllowed ?? null,
    typos: r.typosCorrected ?? 0,
    ...(r.stopped ? { stopped: r.stopped } : {}),
    events,
  };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, JSON.stringify(entry) + '\n');
    return `Logged ${events.length} key event(s)${dryRun ? ' as planned' : ''} to ${target}.`;
  } catch (e) {
    return `The key log could not be written to ${target}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// dry_run: the plan as the browser would run it now, nothing sent and no
// session under way disturbed (Input.dispatchKeystrokes with dryRun).
async function planOnly(
  tab: Tab,
  o: { plan: Step[] | null; text?: string; exact?: boolean; seed?: number; speed: number; keyLog?: string },
): Promise<string> {
  if (!o.plan && !o.text) throw new ToolError('dry_run plans text or keys; give one. Nothing was done.');
  const { params } = keystrokesCall(o);
  const r = await tab.send('Input.dispatchKeystrokes', { ...params, dryRun: true }, 30_000);
  const tl: any[] = r.timeline ?? [];
  const downs = tl.filter((e) => e.event === 'down').map((e) => e.timeMs);
  const ups = tl.filter((e) => e.event === 'up').map((e) => e.timeMs);
  const span = downs.length && ups.length ? Math.max(...ups) - Math.min(...downs) : 0;
  const whole = typeof r.durationMs === 'number' && Math.abs(r.durationMs - span) > 1 ? `; the plan's whole length with its pauses is ${Math.round(r.durationMs)} ms` : '';
  const typos = r.typosCorrected ? `, ${r.typosCorrected} typo(s) made and corrected` : '';
  const lines = [
    `Planned, nothing sent: from its first key down to its last key up it would take ${(span / 1000).toFixed(2)} s (${Math.round(span)} ms${whole}), ${tl.length} key event(s)${typos}.`,
    `Seed ${r.seed} (${typosWords(r)}): pass it back as seed, with the same text or keys and speed, for this schedule (the typo decision follows the focused field, so type into one of the same kind).`,
  ];
  if (o.keyLog !== undefined) lines.push(appendKeyLog(o.keyLog, r, true));
  return lines.join('\n');
}

// After a failed burst the account of what went out is the answer: an error
// from the settle and listing (the browser died mid-burst) is said with it,
// not in its place.
export async function keepAccount(said: string[], list: () => Promise<string>): Promise<string> {
  try {
    return await list();
  } catch (e) {
    const why = e instanceof CdpError ? `${e.method} failed: ${e.message}` : e instanceof Error ? e.message : String(e);
    return [...said, `The page could not be listed afterwards: ${why}`].join('\n');
  }
}

// Plays a burst's steps in order. Between two steps a person's gap; a pause
// step is the gap. Only the last step, when it is a string, reads the field
// back (the browser's field settle adds 150 to 450 ms to each call that
// does). A failure or a cancellation stops the burst, and the answer counts
// what went out before it.
export async function playBurst(
  plan: Step[],
  o: {
    speed: number;
    seed: number;
    signal?: AbortSignal;
    keystrokes: (text: string, typos: number, part: number, readBack: boolean) => Promise<any>;
    chord: (key: string, modifiers?: number, pace?: number) => Promise<void>;
  },
): Promise<{ counts: string; last: any; at: number; failed?: string; cancelled?: boolean }> {
  const rand = seeded(o.seed);
  const n = { chars: 0, bs: 0, pauses: 0, presses: 0 };
  const counts = () => {
    const parts = [`${n.chars} character(s)`];
    if (n.bs) parts.push(`${n.bs} Backspace(s)`);
    if (n.presses) parts.push(`${n.presses} key press(es)`);
    if (n.pauses) parts.push(`${n.pauses} pause(s)`);
    return parts.join(', ');
  };
  let last: any = null;
  let gap = false;
  for (let i = 0; i < plan.length; i++) {
    const s = plan[i];
    try {
      if (o.signal?.aborted) throw new Cancelled();
      if (s.kind === 'pause') {
        await pause(s.ms, o.signal);
        n.pauses++;
        gap = false;
        continue;
      }
      if (gap) await pause(keyGap(rand, o.speed), o.signal);
      gap = true;
      if (s.kind === 'text') {
        if (!s.text) continue;
        const r = await o.keystrokes(s.text, 0, i, i === plan.length - 1);
        last = r;
        n.chars += [...s.text].length;
      } else if (s.kind === 'bs') {
        // A run of Backspaces goes quicker than typing: a chord's own timing
        // put them 240-270 ms apart; a person's are 100-200.
        for (let k = 0; k < s.n; k++) {
          if (o.signal?.aborted) throw new Cancelled();
          await o.chord('Backspace', 0, o.speed * 1.6);
          n.bs++;
        }
      } else {
        await o.chord(s.key, s.modifiers);
        n.presses++;
      }
    } catch (e) {
      if (e instanceof Cancelled) return { counts: counts(), last, at: i, cancelled: true };
      const why = e instanceof CdpError ? `${e.method} failed: ${e.message}` : e instanceof Error ? e.message : String(e);
      return { counts: counts(), last, at: i, failed: why };
    }
  }
  return { counts: counts(), last, at: plan.length };
}

const KEY_NAMES: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  esc: 'Escape',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  space: 'Space',
};

// The keys the browser's chords take by name (Input.dispatchKeyChord); any
// other key is one ASCII character.
const CHORD_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Escape', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Space', 'CapsLock', 'NumLock', 'ScrollLock',
]);

// "Ctrl+Shift+Left" -> the modifier bits and the browser's key name. A "+"
// alone is the key itself ("Ctrl++").
export function chordOf(keys: string): { modifiers: number; key: string } {
  const parts = keys.endsWith('++') ? [...keys.slice(0, -2).split('+'), '+'] : keys.split('+');
  const names = parts.map((s) => (s === '+' ? s : s.trim())).filter(Boolean);
  const keyPart = names.pop();
  if (!keyPart) throw new ToolError(`"${keys}" names no key; name one such as Enter, Escape, Tab or Ctrl+A.`);
  const modifiers = modifierBits(names);
  const key = /^f([1-9]|1[0-2])$/i.test(keyPart)
    ? keyPart.toUpperCase()
    : KEY_NAMES[keyPart.toLowerCase()] ?? ([...keyPart].length === 1 ? keyPart.toLowerCase() : keyPart);
  if ([...key].length !== 1 && !CHORD_KEYS.has(key) && !/^F([1-9]|1[0-2])$/.test(key)) {
    throw new ToolError(`"${keys}": ${JSON.stringify(keyPart)} is not a key; name one character or a key such as Enter, Escape, Tab, ArrowDown, Home or F5.`);
  }
  // The browser's chord takes one character only as a key of the US layout:
  // the printable ASCII characters ! to ~ (BuildKeyMapping in
  // keyboard_typing_session.cc); a space is the named key Space. Anything
  // else would fail midway, after earlier steps went out.
  if ([...key].length === 1 && !(key >= '!' && key <= '~')) {
    throw new ToolError(`"${keys}": a shortcut's key must be an ASCII character (! to ~) or a named key such as Space, Enter or ArrowDown; ${JSON.stringify(keyPart)} is neither. Type other characters as text.`);
  }
  return { modifiers, key };
}

export async function press(
  tab: Tab,
  keys: string,
  times = 1,
  opts: { notBefore?: number; quiet?: boolean; expectFocus?: string; signal?: AbortSignal } = {},
): Promise<string> {
  assertNoDialog(tab);
  const { modifiers, key } = chordOf(keys);
  checkNotBefore(opts.notBefore);
  const ft = await focusTarget(tab, opts.expectFocus);
  await waitUntil(opts.notBefore, opts.signal);
  assertNoDialog(tab);
  const unfocused = (await checkFocus(tab, ft)).refused;
  if (unfocused) return unfocused;
  const began = Date.now();
  let outcome: any;
  let done = 0;
  for (; done < times; done++) {
    if (opts.signal?.aborted) return `Stopped on request after ${done} of ${times} press(es).`;
    const r = await tab.send('Input.dispatchKeyChord', { modifiers, key });
    outcome = r.actionOutcome ?? outcome;
  }
  const said = [`Pressed ${keys}${times > 1 ? ` ${times} times` : ''}.`];
  if (opts.notBefore !== undefined) said.push(timesLine(opts.notBefore, began, Date.now()));
  return afterAction(tab, said, outcome, opts.quiet);
}

export async function scroll(
  tab: Tab,
  opts: { direction: string; amount?: number; id?: string; pace?: string; quiet?: boolean },
): Promise<string> {
  assertNoDialog(tab);
  const over = opts.id ? await resolve(tab, opts.id) : null;
  const r = await withPointer(tab, (p) =>
    tab.send(
      'Input.scrollBy',
      {
        direction: opts.direction,
        amount: opts.amount ?? 400,
        pace: opts.pace ?? 'read',
        ...(over ? { backendNodeId: over.backendNodeId, frameId: over.frameId } : {}),
        ...p,
      },
      60_000,
    ),
  );
  tab.pointer = { x: r.pointerX, y: r.pointerY };
  const SAID: Record<string, string> = {
    scrolled: `Scrolled ${opts.direction} (${r.notches} notch(es)).`,
    end: `Already at the end ${opts.direction}; nothing moved.`,
    still: 'The wheel turned but the page did not move: it takes the wheel there.',
    none: `Nothing under the pointer scrolls ${opts.direction}.`,
  };
  const said = [SAID[r.outcome] ?? `Not scrolled: ${r.outcome}${r.hit ? ` (${r.hit})` : ''}${r.reason ? `, ${r.reason}` : ''}.`];
  if (r.movedOver) said.push(`The hand moved over ${r.movedOver} to find something that scrolls.`);
  return afterAction(tab, said, r.actionOutcome, opts.quiet);
}

export function withScheme(url: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

export async function navigate(tab: Tab, opts: { url?: string; action?: string }): Promise<string> {
  assertNoDialog(tab);
  tab.navigationReplaced();
  const { armId } = await onActivePage(() => tab.send('Page.agentSettleArm'));
  let said: string;
  try {
    if (opts.url) {
      const url = withScheme(opts.url);
      const r = await onActivePage(() => tab.send('Page.navigate', { url }));
      if (r.errorText) return `Could not load ${url}: ${r.errorText}.`;
      said = `Went to ${url}.`;
    } else if (opts.action === 'reload') {
      await onActivePage(() => tab.send('Page.reload'));
      said = 'Reloaded.';
    } else {
      const h = await onActivePage(() => tab.send('Page.getNavigationHistory'));
      const back = opts.action === 'back';
      const entry = h.entries[h.currentIndex + (back ? -1 : 1)];
      if (!entry) return `There is no page to go ${back ? 'back' : 'forward'} to.`;
      const r = await onActivePage(() =>
        tab.send('Page.agentNavigateToHistoryEntry', { entryId: entry.id, timeoutMs: 15_000 }, 30_000),
      );
      if (r.outcome !== 'committed') return `Going ${back ? 'back' : 'forward'} ${r.outcome} (${r.url}).`;
      said = `Went ${back ? 'back' : 'forward'} to ${r.url}.`;
    }
  } finally {
    tab.navigationReplaced();
  }
  const lines = [said];
  const r = await tab.untilDialog(
    (async () => ({ report: await settle(tab, armId), snap: await capture(tab, {}) }))(),
  );
  if (r === 'dialog') return [...lines, ...noticesOf(tab), dialogLine(tab)].join('\n');
  const unsettled = settleLine(r.report);
  if (unsettled) lines.push(unsettled);
  const id = remember(tab, r.snap);
  lines.push(...noticesOf(tab), '', formatListing(r.snap, tab.id, tab.letters, shownOn(tab)), ...(await canvasListing(tab)));
  return withSnapshotId(lines.join('\n'), id);
}

export async function answerDialog(tab: Tab, accept: boolean, text?: string): Promise<string> {
  if (!tab.dialog) return 'No dialog is open.';
  const d = tab.dialog;
  await tab.send('Page.handleJavaScriptDialog', { accept, ...(text !== undefined ? { promptText: text } : {}) });
  tab.dialog = null;
  return afterAction(tab, [`${accept ? 'Accepted' : 'Dismissed'} the ${d.type} dialog ${JSON.stringify(d.message)}.`]);
}

export async function screenshot(tab: Tab, file?: string, fullPage = false): Promise<string> {
  assertNoDialog(tab);
  const r = await onActivePage(() =>
    tab.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage }, 60_000),
  );
  const target = path.resolve(file ?? path.join(process.cwd(), 'screenshots', `${tab.id}-${Date.now()}.png`));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(r.data, 'base64'));
  return `Saved ${fullPage ? 'the whole page' : 'the view'} to ${target}`;
}

export async function evaluate(tab: Tab, expression: string): Promise<{ text: string; isError: boolean }> {
  assertNoDialog(tab);
  // Runtime.evaluate works without Runtime.enable, which stays off.
  const r = await onActivePage(() =>
    tab.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 30_000 }, 40_000),
  );
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails;
    return { text: `It threw: ${ex.exception?.description ?? ex.text}`, isError: true };
  }
  const v = r.result;
  let text: string;
  if (v.type === 'undefined') text = 'undefined';
  else if ('value' in v) text = typeof v.value === 'string' ? v.value : JSON.stringify(v.value, null, 2);
  else text = v.description ?? v.type;
  if (text.length > 40_000) text = `${text.slice(0, 40_000)}\n… (${text.length - 40_000} more characters)`;
  return { text, isError: false };
}

// --- native controls ----------------------------------------------------

// The hand commands that work a control end to end (select, date, colour,
// files): the element is shown first, the command does the rest, and the
// answer's outcome says whether it took.
async function handCommand(
  tab: Tab,
  id: string,
  method: string,
  params: object,
  done: string[],
  timeoutMs = 70_000,
): Promise<{ r: any; t: Target; refused: string | null }> {
  assertNoDialog(tab);
  const t = await resolve(tab, id);
  const hidden = await reveal(tab, t);
  if (hidden) return { r: null, t, refused: `Nothing done. ${hidden}` };
  const r = await withPointer(tab, (p) =>
    tab.send(method, { backendNodeId: t.backendNodeId, frameId: t.frameId, ...params, ...p }, timeoutMs),
  );
  if (r.x !== undefined) tab.pointer = { x: r.x, y: r.y };
  if (done.includes(r.outcome)) return { r, t, refused: null };
  const parts = [r.outcome, r.reason, r.part && `part ${r.part}`, r.path && `path ${r.path}`, r.hit && `at ${r.hit}`];
  return { r, t, refused: `Not done on ${id}: ${parts.filter(Boolean).join(', ')}.` };
}

export async function select(tab: Tab, id: string, values: string[]): Promise<string> {
  const { r, refused } = await handCommand(tab, id, 'Input.selectOptions', { values }, ['picked', 'already']);
  if (refused) {
    const options = r?.options?.length ? ` Its options: ${r.options.join('; ')}${r.optionCount > r.options.length ? ' …' : ''}.` : '';
    const missing = r?.missing?.length ? ` No option for ${r.missing.map((v: string) => JSON.stringify(v)).join(', ')}.` : '';
    return refused + missing + options;
  }
  const picked = r.selected.map((o: any) => JSON.stringify(o.text)).join(', ') || 'nothing';
  const said = r.outcome === 'already' ? `${id} already showed ${picked}.` : `Selected ${picked} in ${id} (by ${r.way}).`;
  return afterAction(tab, [said], r.actionOutcome);
}

export async function fillDate(tab: Tab, id: string, value: string): Promise<string> {
  const { r, refused } = await handCommand(tab, id, 'Input.fillDateTime', { value }, ['filled', 'already']);
  if (refused) return refused;
  return afterAction(tab, [r.outcome === 'already' ? `${id} already held ${value}.` : `Filled ${id} with ${value}.`], r.actionOutcome);
}

export async function pickColor(tab: Tab, id: string, value: string): Promise<string> {
  const { r, refused } = await handCommand(tab, id, 'Input.pickColor', { value }, ['picked', 'already']);
  if (refused) return refused;
  return afterAction(tab, [r.outcome === 'already' ? `${id} already held ${value}.` : `Picked ${value} in ${id}.`], r.actionOutcome);
}

export async function upload(tab: Tab, id: string, files: string[]): Promise<string> {
  // Paths are the browser's machine's; relative ones are taken from the
  // working folder.
  const absolute = files.map((f) => path.resolve(f));
  const { r, refused } = await handCommand(tab, id, 'Input.chooseFiles', { files: absolute }, ['chosen'], 130_000);
  if (refused) return refused + (r?.opener ? ` Try the element that opens it: ${r.opener}.` : '');
  const field = r.field ? ` (${r.field}${r.accept ? `, accepts ${r.accept}` : ''})` : '';
  return afterAction(tab, [`Chose ${absolute.length} file(s) for ${id}${field}.`], r.actionOutcome);
}

// What Input.performDrag answered, told the same way for a drag of an element
// and one from a point: the kind of drag the page made of it and how it ended,
// or, for any other outcome, why (a failed drag is ended by the browser).
function dragFailed(r: any): string {
  return `Not dragged: ${r.outcome}${r.reason ? `, ${r.reason}` : ''}${r.putBack ? ' (let go where it was grabbed)' : ''}.`;
}

// A drag from a point, as a person selects text in an editor that draws its
// own: the browser presses there, carries to the point (or the element) and
// lets go, in one command (Input.performDrag with grabX/grabY), turning the
// wheel under itself where the target is out of view. Modifiers are held
// throughout (Shift to extend). A press on text already selected starts a
// native drag of that text: the answer says so.
async function dragFromPoint(
  tab: Tab,
  from: Point,
  opts: { to?: string; x?: number; y?: number; modifiers?: string[]; quiet?: boolean },
  // How the answer names the drag (a selection by text), in place of its points.
  named?: { first: string; extra?: string | null },
): Promise<string> {
  await checkPoint(tab, from);
  const modifiers = modifierBits(opts.modifiers);
  let target: object;
  let end: string;
  if (opts.to) {
    const t = await resolve(tab, opts.to);
    target = { targetNodeId: t.backendNodeId, targetFrameId: t.frameId };
    end = opts.to;
  } else if (opts.x !== undefined && opts.y !== undefined) {
    const p = { x: opts.x, y: opts.y };
    await checkPoint(tab, p);
    target = { pointX: p.x, pointY: p.y };
    end = at(p);
  } else {
    throw new ToolError('Say where to let go: x and y (a point in the view), or to (an id).');
  }
  const r = await withPointer(tab, (p) =>
    tab.send('Input.performDrag', { grabX: from.x, grabY: from.y, ...target, modifiers, ...p }, 130_000),
  );
  if (r.x !== undefined) tab.pointer = { x: r.x, y: r.y };
  const released = await releaseIfDown(tab, r);
  if (r.outcome !== 'dropped' && r.outcome !== 'released') {
    // Measured 2026-11-17 (release 2.0.0's browser and older): a drag between two points inside a frame of
    // another site is answered covered, naming the frame's own content as
    // what is "on top of where the element to grab would be grabbed" (a
    // click there works). Only that wording gets the hint: a covered
    // target is also told with "in another frame", and is another matter.
    const grabInFrame = r.outcome === 'covered' && /(in|from) another frame is on top of where/.test(r.reason ?? '');
    const failed = dragFailed(r) + (grabInFrame ? ' The start point is inside a frame of another site or process, and the browser did not grab there; a click at a point there works.' : '');
    return released ? `${failed}\n${released}` : failed;
  }
  const said = [named ? `${named.first} (${r.kind} drag, ${r.outcome}).` : `Dragged from ${at(from)} to ${end} (${r.kind} drag, ${r.outcome}).`];
  if (named?.extra) said.push(named.extra);
  if (released) said.push(released);
  if (r.kind === 'native') {
    said.push('The page took the press as a native drag: what was under it (text already selected, a link, an image or a draggable element) was dragged, and no new selection was made.');
  }
  return afterAction(tab, said, r.actionOutcome, opts.quiet);
}

// A selection by text: a drag from the start of `select` to its end, found
// in the canvas text in view with its context (text_before, text_after).
export async function dragText(
  tab: Tab,
  sel: { select: string; before?: string; after?: string },
  opts: { modifiers?: string[]; quiet?: boolean },
): Promise<string> {
  assertNoDialog(tab);
  const { points, caution } = await aimAt(tab, sel.before, sel.select, sel.after, 'selecting by text');
  const [a, b] = points;
  return dragFromPoint(tab, a, { x: b.x, y: b.y, modifiers: opts.modifiers, quiet: opts.quiet }, { first: `Dragged over ${quoted(sel.select)} from ${at(a)} to ${at(b)}`, extra: caution });
}

export async function drag(
  tab: Tab,
  opts: {
    from?: string;
    from_x?: number;
    from_y?: number;
    to?: string;
    x?: number;
    y?: number;
    value?: number;
    slot?: string;
    modifiers?: string[];
    quiet?: boolean;
  },
): Promise<string> {
  assertNoDialog(tab);
  if (opts.from_x !== undefined || opts.from_y !== undefined) {
    if (opts.from || opts.from_x === undefined || opts.from_y === undefined) {
      throw new ToolError('Start the drag at an element (from) or at a point (from_x and from_y), not both.');
    }
    if (opts.value !== undefined || opts.slot) throw new ToolError('value and slot are for dragging an element.');
    return dragFromPoint(tab, { x: opts.from_x, y: opts.from_y }, opts);
  }
  if (!opts.from) throw new ToolError('Say where the drag starts: from (an id), or from_x and from_y.');
  if (opts.modifiers?.length) throw new ToolError('modifiers are for a drag from a point.');
  const grab = await resolve(tab, opts.from);
  const hidden = await reveal(tab, grab);
  if (hidden) return `Not dragged. ${hidden}`;
  let target: object;
  if (opts.to) {
    const t = await resolve(tab, opts.to);
    target = { targetNodeId: t.backendNodeId, targetFrameId: t.frameId, ...(opts.slot ? { slot: opts.slot } : {}) };
  } else if (opts.x !== undefined && opts.y !== undefined) {
    target = { pointX: opts.x, pointY: opts.y };
  } else if (opts.value !== undefined) {
    target = { value: opts.value };
  } else {
    throw new ToolError('Say where to drop: to (an id), x and y (a point in the view), or value (a slider).');
  }
  const r = await withPointer(tab, (p) =>
    tab.send('Input.performDrag', { grabNodeId: grab.backendNodeId, grabFrameId: grab.frameId, ...target, ...p }, 130_000),
  );
  if (r.x !== undefined) tab.pointer = { x: r.x, y: r.y };
  const released = await releaseIfDown(tab, r);
  if (r.outcome !== 'dropped' && r.outcome !== 'released') return released ? `${dragFailed(r)}\n${released}` : dragFailed(r);
  const said = [`Dragged ${opts.from} (${r.kind} drag, ${r.outcome}).`];
  if (released) said.push(released);
  if (r.grabIndexBefore !== undefined && r.grabIndexAfter !== undefined && r.valueBefore === undefined) {
    said.push(`Its place in its list: ${r.grabIndexBefore} → ${r.grabIndexAfter} of ${r.siblingCount}.`);
  }
  if (r.valueBefore !== undefined) said.push(`Its value: ${r.valueBefore} → ${r.valueAfter}.`);
  return afterAction(tab, said, r.actionOutcome, opts.quiet);
}

export async function paste(
  tab: Tab,
  text: string,
  id?: string,
  opts: { notBefore?: number; quiet?: boolean; expectFocus?: string; signal?: AbortSignal } = {},
): Promise<string> {
  assertNoDialog(tab);
  checkNotBefore(opts.notBefore);
  const ft = await focusTarget(tab, opts.expectFocus);
  if (id) {
    const refused = await clickInto(tab, id, 'Nothing pasted.');
    if (refused) return refused;
  }
  await waitUntil(opts.notBefore, opts.signal);
  assertNoDialog(tab);
  const unfocused = (await checkFocus(tab, ft)).refused;
  if (unfocused) return unfocused;
  const stopped = cancelledLine(opts.signal, 'nothing was pasted');
  if (stopped) return stopped;
  const began = Date.now();
  const r = await tab.send('Input.dispatchPaste', { text, readBack: true }, 30_000);
  const where = r.fieldBefore?.kind === 'none' ? ' (nothing had focus: the paste went to the page)' : '';
  // An editor with a document of its own (Google Docs) takes keys and pastes
  // in a field it keeps empty, so an empty field says less than one that holds
  // other text.
  const landed =
    r.fieldAfter?.contains !== false
      ? ''
      : r.fieldAfter?.length === 0
        ? ' The field is empty afterwards: the paste did not land, or the page keeps its text elsewhere (as Google Docs does).'
        : ' The field does not hold the text afterwards.';
  const said = [`Pasted ${text.length} character(s)${id ? ` into ${id}` : ''}${where}.${landed}`];
  if (opts.notBefore !== undefined) said.push(timesLine(opts.notBefore, began, Date.now()));
  return afterAction(tab, said, r.actionOutcome, opts.quiet);
}
