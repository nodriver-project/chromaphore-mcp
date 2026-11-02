// Turns Page.captureAgentSnapshot's answer into the text the model reads: one
// line per element, with the id it acts by (the element's label, "a12"), and
// after an action only what changed.

// The states every visible, usable control has; the line names the rest.
const QUIET_STATES = new Set(['visible', 'enabled', 'focusable', 'editable']);
const MAX_LISTING_CHARS = 45_000;
const MAX_TEXT = 120;

export function clip(s: string | undefined, max = MAX_TEXT): string {
  if (!s) return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

function roleWord(e: any): string {
  if (e.role === 'LabelText') return 'label';
  if (e.role === 'StaticText' || e.role === 'generic') return 'text';
  return e.role;
}

// Where an element is when it is not in view.
function place(e: any, vp: any): string {
  if (e.inViewport) return '';
  if (e.y + e.height <= 0) return 'above the view';
  if (e.y >= vp.height) return 'below the view';
  if (e.x + e.width <= 0) return 'left of the view';
  return 'right of the view';
}

export function elementLine(e: any, vp: any, layers?: any[]): string {
  const parts = [e.label ?? `#${e.agentNodeId}`, roleWord(e)];
  const name = clip(e.name);
  if (name) parts.push(JSON.stringify(name));
  else if (!e.interactive && e.reads) parts.push(JSON.stringify(clip(e.reads)));
  if (e.value !== undefined && e.value !== null && e.role !== 'button') {
    parts.push(`value=${JSON.stringify(clip(e.value, 200))}`);
  }
  const states = (e.states ?? []).filter((s: string) => !QUIET_STATES.has(s));
  if (states.length) parts.push(states.join(' '));
  if (e.invalid?.length) parts.push(`invalid: ${e.invalid.join(', ')}${e.error ? ` "${clip(e.error)}"` : ''}`);
  if (e.href) parts.push(`→ ${clip(e.href, 200)}`);
  else if (e.src && e.tag === 'iframe') parts.push(`src ${clip(e.src, 200)}`);
  const where = place(e, vp);
  if (where) parts.push(`(${where})`);
  if (e.obscured || (e.coveredBy && !e.marked)) {
    parts.push(`(covered${e.coveredBy ? ` by ${clip(e.coveredBy, 80)}` : ''})`);
  }
  if (e.layer !== undefined && layers?.[e.layer] && layers.length > 1) parts.push(`[in ${layers[e.layer].kind}]`);
  if (e.marked && e.color) parts.push(`[${e.color}]`);
  return parts.join(' ');
}

function header(snap: any, tabId: string): string[] {
  const vp = snap.viewport;
  const lines = [
    `Tab ${tabId} · ${JSON.stringify(clip(snap.title, 100))} · ${snap.url}`,
    `View ${vp.width}x${vp.height}, scrolled to ${Math.round(vp.scrollX)},${Math.round(vp.scrollY)}.`,
  ];
  for (const l of snap.layers ?? []) {
    lines.push(
      `Open on top: ${l.kind} ${JSON.stringify(clip(l.name, 80))}${l.blocking ? ' (blocks the page behind it)' : ''}` +
        `${l.animatingMs ? `, still animating ${l.animatingMs} ms` : ''}.`,
    );
  }
  for (const h of snap.hidden ?? []) {
    lines.push(
      `Behind ${clip(h.behind, 80)}: ${h.inView} in view and ${h.offscreen} off-screen not listed ` +
        '(observe with scope "all" lists them).',
    );
  }
  if (snap.unansweredFrames) lines.push(`${snap.unansweredFrames} frame(s) did not answer and are not listed.`);
  return lines;
}

function heardLines(snap: any): string[] {
  return (snap.heard ?? [])
    .filter((h: any) => !h.gone && !h.beforeAction)
    .map((h: any) => `Announced (${h.region.kind}): ${JSON.stringify(clip(h.added ?? h.region.text, 200))}`);
}

// A label whose text is the name of a listed control says nothing the
// control's own line does not, and its id invites acting on the label.
function redundantLabels(elements: any[]): Set<number> {
  const names = new Set(elements.filter((e) => e.interactive && e.name).map((e) => clip(e.name)));
  return new Set(
    elements
      .filter((e) => e.role === 'LabelText' && !e.interactive && names.has(clip(e.name ?? e.reads)))
      .map((e) => e.agentNodeId),
  );
}

export function formatListing(snap: any, tabId: string): string {
  const lines = header(snap, tabId);
  lines.push('');
  let size = lines.join('\n').length;
  const skip = redundantLabels(snap.elements);
  const listed = snap.elements.filter((e: any) => !skip.has(e.agentNodeId));
  let shown = 0;
  for (const e of listed) {
    const line = elementLine(e, snap.viewport, snap.layers);
    if (size + line.length > MAX_LISTING_CHARS) break;
    lines.push(line);
    size += line.length + 1;
    shown++;
  }
  if (shown < listed.length) {
    lines.push(`… ${listed.length - shown} more not shown (observe with offscreen "none" lists only the view).`);
  }
  if (!snap.elements.length) lines.push('(nothing listed)');
  lines.push(...heardLines(snap));
  return lines.join('\n');
}

// What changed since the listing named by `since`, or the full listing when
// the delta does not apply (a new document, or the baseline was too old).
export function formatChange(snap: any, tabId: string): string {
  const d = snap.delta;
  if (!d || snap.baseline === false) return formatListing(snap, tabId);
  const byId = new Map<number, any>(snap.elements.map((e: any) => [e.agentNodeId, e]));
  const skip = redundantLabels(snap.elements);
  const lines: string[] = [];
  if (d.url) lines.push(`URL now ${d.url}`);
  if (d.title) lines.push(`Title now ${JSON.stringify(clip(d.title, 100))}`);
  for (const i of d.layersOpened ?? []) {
    const l = snap.layers?.[i];
    if (l) lines.push(`Opened: ${l.kind} ${JSON.stringify(clip(l.name, 80))}${l.blocking ? ' (blocks the page)' : ''}`);
  }
  for (const l of d.layersClosed ?? []) lines.push(`Closed: ${l.kind} ${JSON.stringify(clip(l.name, 80))}`);
  for (const a of d.added ?? []) {
    const e = byId.get(a.agentNodeId);
    if (e && !skip.has(e.agentNodeId)) {
      lines.push(`+ ${elementLine(e, snap.viewport, snap.layers)}${a.why === 'new' ? '' : ` (${a.why.replace(/_/g, ' ')})`}`);
    }
  }
  // What only scrolled out of view is said in one line; what left the page
  // or was hidden or covered, element by element.
  const removed = (d.removed ?? []).filter((r: any) => !(r.role === 'LabelText' && skip.size));
  const outOfView = removed.filter((r: any) => r.why === 'out_of_view');
  for (const r of outOfView.length > 5 ? removed.filter((r: any) => r.why !== 'out_of_view') : removed) {
    lines.push(`- ${r.label} ${roleWord(r)}${r.name ? ` ${JSON.stringify(clip(r.name))}` : ''} (${r.why.replace(/_/g, ' ')})`);
  }
  if (outOfView.length > 5) {
    lines.push(`- ${outOfView.length} elements went out of view (${outOfView[0].label} … ${outOfView.at(-1).label})`);
  }
  for (const c of d.changed ?? []) {
    const e = byId.get(c.agentNodeId);
    const who = e ? `${e.label} ${roleWord(e)}${e.name ? ` ${JSON.stringify(clip(e.name, 60))}` : ''}` : `#${c.agentNodeId}`;
    if (c.what === 'state') {
      const from = new Set<string>(c.fromStates ?? []);
      const to = new Set<string>(c.toStates ?? []);
      const gained = [...to].filter((s) => !from.has(s) && !QUIET_STATES.has(s));
      const lost = [...from].filter((s) => !to.has(s) && !QUIET_STATES.has(s));
      const words = [...gained.map((s) => `now ${s}`), ...lost.map((s) => `no longer ${s}`)];
      if (words.length) lines.push(`~ ${who}: ${words.join(', ')}`);
    } else {
      lines.push(`~ ${who}: ${c.what} ${JSON.stringify(clip(c.from ?? '', 80))} → ${JSON.stringify(clip(c.to ?? '', 80))}`);
    }
  }
  const reordered = (d.reordered ?? []).map((n: number) => byId.get(n)).filter(Boolean);
  if (reordered.length) {
    const named = reordered.slice(0, 10).map((e: any) => `${e.label}${e.name ? ` ${JSON.stringify(clip(e.name, 40))}` : ''}`);
    lines.push(`Order changed: ${named.join(', ')}${reordered.length > 10 ? ` and ${reordered.length - 10} more` : ''}`);
  }
  if (d.focus) lines.push(d.focus.label ? `Focus on ${d.focus.label}` : 'Focus left the listed elements');
  if (d.scroll) lines.push(`Scrolled to ${d.scroll.x},${d.scroll.y}`);
  lines.push(...heardLines(snap));
  if (d.partial) lines.push('A frame did not answer; its elements are as before.');
  if (!lines.length) return 'No change on the page.';
  return lines.join('\n');
}

export function settleLine(report: any): string {
  const s = report?.settle;
  if (!s) return '';
  if (s.settled) return '';
  const what = (s.stillChanging ?? []).map((c: any) => `${c.kind} ${clip(c.what, 80)}`).join('; ');
  return `The page had not settled after ${Math.round(s.afterMs)} ms${what ? `: still changing ${what}` : ''}.`;
}
