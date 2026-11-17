// Google Docs: where the caret is and what is selected, as text, from facts
// only true of Docs (docs/DESIGN.md, "Editor modules"; measured by the lead
// on a real document, 2026-11-17):
// - its pages are canvases of class kix-canvas-tile-content;
// - the caret is a DOM element, #kix-current-user-cursor-caret, inside an
//   element of class kix-cursor that has display: none while a selection
//   exists; its left edge sits at a run's boundary within half a pixel, and
//   its box spans the line;
// - the caret stays drawn (no longer blinking) when the keyboard focus is
//   elsewhere, in the title box say: with the document focused, the page's
//   active element is the frame that takes its keys, an iframe of class
//   docs-texteventtarget-iframe;
// - a selection is fillRects of colour rgba(78, 143, 248, 0.5) while the
//   document has the focus and rgba(143, 143, 143, 0.34) while it does not,
//   one per line, its edges at run boundaries, reaching one space's width
//   past the line's last run when the line's end is selected.
import { pointOf, type Fill, type Line, type Piece } from '../canvas.js';
import type { Editor, EditorPage } from './index.js';

// The page's signature, and the caret's box and whether it shows, in one
// evaluation in an isolated world. getBoundingClientRect gives CSS pixels of
// the view, the space the canvas text's points are in at the page's own zoom.
const READ = `(() => {
  if (!document.querySelector('canvas.kix-canvas-tile-content')) return null;
  // Whether the frame that takes the document's keys has the focus; left
  // out when the page has no such frame.
  const target = document.querySelector('iframe.docs-texteventtarget-iframe');
  const focus = target ? { focused: document.activeElement === target } : {};
  const caret = document.getElementById('kix-current-user-cursor-caret');
  if (!caret) return { caret: null, ...focus };
  for (let e = caret; e && e.nodeType === 1; e = e.parentElement) {
    if (getComputedStyle(e).display === 'none') return { caret: null, ...focus };
  }
  const r = caret.getBoundingClientRect();
  if (!(r.height > 0)) return { caret: null, ...focus };
  return { caret: { x: r.left, top: r.top, height: r.height }, view: { width: innerWidth, height: innerHeight }, ...focus };
})()`;

export interface Caret {
  x: number;
  top: number;
  height: number;
}

export interface DocsState {
  caret: Caret | null;
  view?: { width: number; height: number };
  // The document's key target has the focus; absent when the page has no
  // such frame to judge by.
  focused?: boolean;
}

// The selection's two colours, as red, green, blue and alpha.
const FOCUSED = [78, 143, 248, 0.5];
const UNFOCUSED = [143, 143, 143, 0.34];

// A fill's colour as rgba, its alpha times the global alpha it was drawn
// with; null for a colour this does not read (a gradient, a name).
export function rgbaOf(f: Pick<Fill, 'color' | 'alpha'>): number[] | null {
  const c = f.color.trim().toLowerCase();
  let m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(c);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), (m[4] === undefined ? 1 : Number(m[4])) * (f.alpha ?? 1)];
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(c);
  if (m) {
    const n = parseInt(m[1], 16);
    const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
    return [n >> 16, (n >> 8) & 255, n & 255, a * (f.alpha ?? 1)];
  }
  return null;
}

const same = (a: number[] | null, b: number[]) => !!a && a.slice(0, 3).every((v, i) => v === b[i]) && Math.abs(a[3] - b[3]) < 0.005;

// --- the text as a string, and where each boundary of a run lies --------

const boxOf = (p: Piece) => {
  const ys = p.run.quad.map((q) => q.y);
  return { top: Math.min(...ys), bottom: Math.max(...ys) };
};

// A boundary of a run: before the character ci of its piece's text, at index
// `at` of its line's text, at x along the run's baseline.
interface Spot {
  at: number;
  x: number;
}

interface LineModel {
  line: Line;
  // Where the line's text starts in the whole text (the lines joined by one
  // space, as part A's flow joins them).
  start: number;
  spots: Spot[];
  top: number;
  bottom: number;
  // The right end of the line's last run, and that run's box height.
  end: number;
  endHeight: number;
}

function modelOf(lines: Line[]): { text: string; lines: LineModel[] } {
  const out: LineModel[] = [];
  let start = 0;
  for (const line of lines) {
    const spots: Spot[] = [];
    let off = 0;
    let top = Infinity;
    let bottom = -Infinity;
    line.pieces.forEach((p, k) => {
      if (line.joined[k]) off++;
      for (let ci = 0; ci <= p.text.length; ci++) spots.push({ at: off + ci, x: pointOf({ piece: p, ci }).x });
      off += p.text.length;
      const b = boxOf(p);
      top = Math.min(top, b.top);
      bottom = Math.max(bottom, b.bottom);
    });
    const last = line.pieces.at(-1)!;
    const lb = boxOf(last);
    out.push({ line, start, spots, top, bottom, end: pointOf({ piece: last, ci: last.text.length }).x, endHeight: lb.bottom - lb.top });
    start += line.text.length + 1;
  }
  return { text: lines.map((l) => l.text).join(' '), lines: out };
}

// How much of a's span [top, bottom] b's covers, as a share of the smaller.
function overlap(a: { top: number; bottom: number }, b: { top: number; bottom: number }): number {
  const o = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const h = Math.min(a.bottom - a.top, b.bottom - b.top);
  return h > 0 ? o / h : 0;
}

const nearest = (spots: Spot[], x: number) =>
  spots.reduce((best, s) => (Math.abs(s.x - x) < Math.abs(best.x - x) ? s : best), spots[0]);

const CONTEXT = 40;
const MAX_SELECTION = 400;
const at = (x: number, y: number) => `(${Math.round(x * 10) / 10}, ${Math.round(y * 10) / 10})`;
const q = (s: string) => JSON.stringify(s);

// --- the caret ----------------------------------------------------------

function caretLine(m: ReturnType<typeof modelOf>, c: Caret, view?: { width: number; height: number }): string {
  if (view && (c.top + c.height <= 0 || c.top >= view.height)) {
    return `Docs caret: out of view (${c.top < 0 ? 'above' : 'below'} it, at y ${Math.round(c.top)}).`;
  }
  const span = { top: c.top, bottom: c.top + c.height };
  const around = (i: number) => `after ${q(m.text.slice(Math.max(0, i - CONTEXT), i))} and before ${q(m.text.slice(i, i + CONTEXT))}`;
  // The boundary nearest the caret's left edge among the lines its box spans.
  let best: { l: LineModel; s: Spot } | null = null;
  for (const l of m.lines) {
    if (overlap(span, l) <= 0.5) continue;
    const s = nearest(l.spots, c.x);
    if (!best || Math.abs(s.x - c.x) < Math.abs(best.s.x - c.x)) best = { l, s };
  }
  if (best && Math.abs(best.s.x - c.x) <= 2) {
    const where = best.s.at === 0 ? ' (at the start of a line)' : best.s.at === best.l.line.text.length ? ' (at the end of a line)' : '';
    return `Docs caret: ${around(best.l.start + best.s.at)}${where}.`;
  }
  if (best) {
    return `Docs caret: at ${at(c.x, c.top)}, on the line ${q(best.l.line.text.slice(0, 60))}, but at no boundary of its text in view within 2 px.`;
  }
  // No line with text at its height: an empty line, between the lines above
  // and below it.
  const mid = c.top + c.height / 2;
  const next = m.lines.find((l) => l.top >= mid);
  const i = next ? next.start : m.text.length;
  return `Docs caret: at ${at(c.x, c.top)}, on a line that holds no text in view (an empty line), ${around(i)}.`;
}

// --- the selection --------------------------------------------------------

interface Part {
  y: number;
  text: string;
  pastEnd: boolean;
}

function selectionLine(m: ReturnType<typeof modelOf>, fills: { f: Fill; focused: boolean }[]): string[] {
  const parts = new Map<LineModel | number, Part & { from: number; to: number }>();
  for (const { f } of fills) {
    const xs = f.quad.map((p) => p.x);
    const ys = f.quad.map((p) => p.y);
    const box = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
    let line: LineModel | null = null;
    for (const l of m.lines) if (overlap(box, l) > 0.5 && (!line || overlap(box, l) > overlap(box, line))) line = l;
    if (!line) {
      // A fill on a line with no text: an empty line whose break is selected.
      parts.set(box.top, { y: box.top, text: '', pastEnd: true, from: 0, to: 0 });
      continue;
    }
    const pastEnd = box.right > line.end + 0.15 * line.endHeight;
    const from = nearest(line.spots, box.left).at;
    const to = pastEnd ? line.line.text.length : nearest(line.spots, box.right).at;
    const had = parts.get(line);
    const a = Math.min(from, had?.from ?? from);
    const b = Math.max(to, had?.to ?? to);
    parts.set(line, { y: line.top, text: line.line.text.slice(a, b), pastEnd: pastEnd || !!had?.pastEnd, from: a, to: b });
  }
  const sorted = [...parts.values()].sort((a, b) => a.y - b.y);
  const whole = sorted.map((p) => p.text).join('\n');
  const n = sorted.reduce((s, p) => s + p.text.length, 0);
  const shown = whole.length > MAX_SELECTION ? whole.slice(0, MAX_SELECTION - 1) + '…' : whole;
  const out = [`Docs selection: ${q(shown)} (${n} characters as drawn, on ${sorted.length} line(s)).`];
  const ends = sorted.flatMap((p, i) => (p.pastEnd ? [i + 1] : []));
  if (ends.length) {
    out[0] +=
      sorted.length === 1
        ? ' The space or break at the end of its line is selected too.'
        : ` The space or break at the end of line${ends.length > 1 ? 's' : ''} ${ends.join(', ')} of it is selected too.`;
  }
  if (fills.some((x) => !x.focused)) out[0] += ' The document does not have the keyboard focus (the selection is drawn grey).';
  return out;
}

// The lines for a Docs page, from its canvas text, its selection fills and
// the caret read in the page.
export function docsLines(lines: Line[], fills: Fill[], state: DocsState): string[] {
  const m = modelOf(lines);
  const selection: { f: Fill; focused: boolean }[] = [];
  for (const f of fills) {
    const c = rgbaOf(f);
    if (same(c, FOCUSED)) selection.push({ f, focused: true });
    else if (same(c, UNFOCUSED)) selection.push({ f, focused: false });
  }
  const out: string[] = [];
  if (state.caret) {
    // Docs keeps the caret drawn when the focus is elsewhere.
    const elsewhere = state.focused === false ? ' The document does not have the keyboard focus: keys would not go there.' : '';
    out.push(caretLine(m, state.caret, state.view) + elsewhere);
  }
  if (selection.length) out.push(...selectionLine(m, selection));
  if (!out.length) {
    out.push('Docs: no caret and no selection show (the document does not have the keyboard focus, or they are out of view).');
  }
  return out;
}

export const docs: Editor = {
  name: 'Google Docs',
  async describe(page: EditorPage): Promise<string[] | null> {
    const state = (await page.evaluate(READ)) as DocsState | null;
    if (!state) return null;
    const fills = page.read.canvases.filter((c) => c.context === '2d').flatMap((c) => c.fills ?? []);
    return docsLines(page.lines, fills, state);
  },
};
