// What each browser tool does with the custom CDP commands. Every action ends
// the same way: the browser's settle for that action, then a listing of what
// changed since the tab's last one.
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { CdpError } from './cdp.js';
import { ToolError, describeEvent, onActivePage, pageOf, type Shown, type Tab } from './browser.js';
import { clip, formatChange, formatListing, settleLine } from './listing.js';

// Screenshots kept for `view`, newest last.
const images = new Map<string, { data: string; mimeType: string; letters: string }>();
let snapshotCounter = 0;
const KEEP_IMAGES = 8;

export function image(snapshotId: string): { data: string; mimeType: string; letters: string } {
  const img = images.get(snapshotId);
  if (!img) throw new ToolError(`No snapshot ${snapshotId} (only the last ${KEEP_IMAGES} are kept). Call observe again.`);
  return img;
}

function keepImage(base64: string | undefined, letters: string): string | null {
  if (!base64) return null;
  const id = `s${++snapshotCounter}`;
  images.set(id, { data: base64, mimeType: 'image/jpeg', letters });
  while (images.size > KEEP_IMAGES) images.delete(images.keys().next().value!);
  return id;
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
  return keepImage(snap.screenshot, tab.letters);
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

// The end of every action: settle on the action's own arm, then what changed.
async function afterAction(tab: Tab, said: string[], outcome?: any): Promise<string> {
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
  lines.push(...noticesOf(tab), '', formatChange(r.snap, tab.id, tab.letters, shownOn(tab)));
  return withSnapshotId(lines.join('\n'), id);
}

export async function observe(tab: Tab, offscreen?: string, scope?: string): Promise<string> {
  assertNoDialog(tab);
  await settle(tab);
  const snap = await capture(tab, { offscreenMode: offscreen ?? 'summary', scope: scope ?? 'on' });
  const id = remember(tab, snap);
  return withSnapshotId([...noticesOf(tab), formatListing(snap, tab.id, tab.letters, shownOn(tab))].join('\n'), id);
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

async function moveTo(tab: Tab, t: Target, end?: object, modifiers = 0): Promise<any> {
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
  tab.pointer = { x: r.x, y: r.y };
  return r;
}

function refusal(verb: string, t: Target, r: any): string {
  const why = MOVE_REFUSALS[r.outcome] ?? r.outcome;
  const hit = r.hit ? ` (${r.hit}${r.hitKind ? `, ${r.hitKind}` : ''})` : '';
  return `Did not ${verb} ${t.label}: ${why}${hit}.${r.reason && !MOVE_REFUSALS[r.reason] ? ` ${r.reason}` : ''}`;
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
  opts: { button?: string; count?: number; modifiers?: string[] } = {},
): Promise<string> {
  assertNoDialog(tab);
  const t = await resolve(tab, id);
  const hidden = await reveal(tab, t);
  if (hidden) return `Not clicked. ${hidden}`;
  const end = { action: 'click', button: opts.button ?? 'left', clickCount: opts.count ?? 1 };
  const r = await moveTo(tab, t, end, modifierBits(opts.modifiers));
  if (r.outcome !== 'clicked') return refusal('click', t, r);
  const landed = r.hit ? ` (the press landed on ${r.hit})` : '';
  return afterAction(tab, [`Clicked ${id}${landed}.`], r.actionOutcome);
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

export async function type(
  tab: Tab,
  opts: { id?: string; text: string; clear?: boolean; submit?: boolean; exact?: boolean },
): Promise<string> {
  assertNoDialog(tab);
  const said: string[] = [];
  if (opts.id) {
    const t = await resolve(tab, opts.id);
    const hidden = await reveal(tab, t);
    if (hidden) return `Nothing typed. ${hidden}`;
    const r = await moveTo(tab, t, { action: 'click' });
    if (r.outcome !== 'clicked') return refusal('click into', t, r);
  }
  if (opts.clear) {
    await tab.send('Input.dispatchKeyChord', { modifiers: 2, key: 'a' });
    if (!opts.text) await tab.send('Input.dispatchKeyChord', { modifiers: 0, key: 'Delete' });
  }
  let outcome: any;
  if (opts.text) {
    const typos = opts.exact ? 0 : 0.015;
    const r = await tab.send(
      'Input.dispatchKeystrokes',
      {
        text: opts.text,
        keystrokeDelayMin: 60,
        keystrokeDelayMax: 260,
        thinkingPauseProbability: 0.02,
        thinkingPauseMin: 300,
        thinkingPauseMax: 800,
        typoProbability: typos,
        ...(typos ? { noTypos: NO_TYPOS } : {}),
        seed: randomInt(0, 2 ** 47),
        readBack: true,
      },
      30_000 + opts.text.length * 1_000,
    );
    outcome = r.actionOutcome;
    const where = r.fieldBefore?.kind === 'none' ? ' (nothing had focus: the keys went to the page)' : '';
    const typoWords = r.typosCorrected ? `, making and correcting ${r.typosCorrected} typo(s)` : '';
    said.push(`Typed ${opts.text.length} character(s)${opts.id ? ` into ${opts.id}` : ''}${typoWords}${where}.`);
    if (r.fieldAfter?.moved) said.push('Focus moved on by itself after the keys.');
  } else if (opts.clear) {
    said.push(`Cleared ${opts.id ?? 'the focused field'}.`);
  }
  if (opts.submit) {
    const r = await tab.send('Input.dispatchKeyChord', { modifiers: 0, key: 'Enter' });
    outcome = r.actionOutcome ?? outcome;
    said.push('Pressed Enter.');
  }
  return afterAction(tab, said, outcome);
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

export async function press(tab: Tab, keys: string, times = 1): Promise<string> {
  assertNoDialog(tab);
  const parts = keys.split('+').map((s) => s.trim()).filter(Boolean);
  const keyPart = parts.pop();
  if (!keyPart) throw new ToolError('Name a key, such as Enter, Escape, Tab or Ctrl+A.');
  const modifiers = modifierBits(parts);
  const key = /^f([1-9]|1[0-2])$/i.test(keyPart)
    ? keyPart.toUpperCase()
    : KEY_NAMES[keyPart.toLowerCase()] ?? (keyPart.length === 1 ? keyPart.toLowerCase() : keyPart);
  let outcome: any;
  for (let i = 0; i < times; i++) {
    const r = await tab.send('Input.dispatchKeyChord', { modifiers, key });
    outcome = r.actionOutcome ?? outcome;
  }
  return afterAction(tab, [`Pressed ${keys}${times > 1 ? ` ${times} times` : ''}.`], outcome);
}

export async function scroll(
  tab: Tab,
  opts: { direction: string; amount?: number; id?: string; pace?: string },
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
  return afterAction(tab, said, r.actionOutcome);
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
  lines.push(...noticesOf(tab), '', formatListing(r.snap, tab.id, tab.letters, shownOn(tab)));
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

export async function drag(
  tab: Tab,
  opts: { from: string; to?: string; x?: number; y?: number; value?: number; slot?: string },
): Promise<string> {
  assertNoDialog(tab);
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
  if (r.outcome !== 'dropped' && r.outcome !== 'released') {
    return `Not dragged: ${r.outcome}${r.reason ? `, ${r.reason}` : ''}${r.putBack ? ' (let go where it was grabbed)' : ''}.`;
  }
  const said = [`Dragged ${opts.from} (${r.kind} drag, ${r.outcome}).`];
  if (r.grabIndexBefore !== undefined && r.grabIndexAfter !== undefined && r.valueBefore === undefined) {
    said.push(`Its place in its list: ${r.grabIndexBefore} → ${r.grabIndexAfter} of ${r.siblingCount}.`);
  }
  if (r.valueBefore !== undefined) said.push(`Its value: ${r.valueBefore} → ${r.valueAfter}.`);
  return afterAction(tab, said, r.actionOutcome);
}

export async function paste(tab: Tab, text: string, id?: string): Promise<string> {
  assertNoDialog(tab);
  if (id) {
    const t = await resolve(tab, id);
    const hidden = await reveal(tab, t);
    if (hidden) return `Nothing pasted. ${hidden}`;
    const r = await moveTo(tab, t, { action: 'click' });
    if (r.outcome !== 'clicked') return refusal('click into', t, r);
  }
  const r = await tab.send('Input.dispatchPaste', { text, readBack: true }, 30_000);
  const where = r.fieldBefore?.kind === 'none' ? ' (nothing had focus: the paste went to the page)' : '';
  const landed = r.fieldAfter?.contains === false ? ' The field does not hold the text afterwards.' : '';
  return afterAction(tab, [`Pasted ${text.length} character(s)${id ? ` into ${id}` : ''}${where}.${landed}`], r.actionOutcome);
}
