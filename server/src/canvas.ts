// The text 2D canvases show, from Page.agentCanvasText (browsers newer than
// release 2.0.0; docs/DESIGN.md, "Canvas text"): read as lines for the
// listing, compared after an action, and searched for a place to aim at.
import { ToolError, type Tab } from './browser.js';

export interface Pt {
  x: number;
  y: number;
}

export interface Run {
  text: string;
  // ltr or rtl, and whether the run holds more than one direction.
  direction?: string;
  bidi?: boolean;
  baseline: { start: Pt; end: Pt };
  width: number;
  advances: number[];
  quad: Pt[];
  exact: boolean;
  inexact?: string;
}

// A filled rectangle the canvas still shows: its colour as the page set it
// (a CSS colour string, measured 2026-11-17: "rgba(78, 143, 248, 0.5)" as
// given, "#4e8ff8" for a hex), and the global alpha it was drawn with.
export interface Fill {
  quad: Pt[];
  color: string;
  alpha: number;
  exact: boolean;
}

export interface Canvas {
  context: string;
  shownRect?: { x: number; y: number; width: number; height: number };
  exact: boolean;
  truncated: boolean;
  runs: Run[];
  fills?: Fill[];
}

export interface CanvasRead {
  canvases: Canvas[];
  framesLeftOut: string[];
  runsCut: number;
  fillsCut: number;
}

// A run as the lines show it: its text without format characters, and for
// each boundary of that text the boundary of the raw text (advances has one
// entry per UTF-16 boundary of the raw text).
export interface Piece {
  run: Run;
  canvas: Canvas;
  text: string;
  map: number[];
}

export interface Line {
  text: string;
  pieces: Piece[];
  // joined[k]: one space stands between pieces k-1 and k.
  joined: boolean[];
}

// Bidi controls and marks: Google Docs wraps every string it draws in
// U+202D ... U+202C.
const FORMAT = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/;

export async function readCanvas(tab: Tab): Promise<CanvasRead> {
  return tab.send('Page.agentCanvasText', { inView: true }, 30_000);
}

function piece(run: Run, canvas: Canvas): Piece | null {
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < run.text.length; i++) {
    if (FORMAT.test(run.text[i])) continue;
    map.push(i);
    text += run.text[i];
  }
  // The end: right after the last character kept.
  let end = run.text.length;
  while (end > 0 && FORMAT.test(run.text[end - 1])) end--;
  map.push(end);
  return text.trim() ? { run, canvas, text, map } : null;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
// The run's box height: its ascent above the baseline and descent below.
const heightOf = (p: Piece) => dist(p.run.quad[0], p.run.quad[3]);

function rotated(r: Run): boolean {
  const dx = r.baseline.end.x - r.baseline.start.x;
  const dy = r.baseline.end.y - r.baseline.start.y;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return false;
  return dx <= 0 || Math.abs(dy) > dx * 0.02;
}

// Runs on one baseline (within half the smaller box height) are one line,
// ordered by x; a gap wider than 0.15 of the smaller height stands for a
// space the page did not draw. A rotated run is a line of its own. Lines are
// read top to bottom within each canvas, canvases in the answer's (page)
// order.
export function linesOf(read: CanvasRead): Line[] {
  const all: Line[] = [];
  for (const canvas of read.canvases) {
    if (canvas.context !== '2d') continue;
    const flat: Piece[] = [];
    const lines: { y: number; h: number; pieces: Piece[] }[] = [];
    for (const run of canvas.runs ?? []) {
      const p = piece(run, canvas);
      if (!p) continue;
      if (rotated(run)) lines.push({ y: Math.min(...run.quad.map((q) => q.y)), h: 0, pieces: [p] });
      else flat.push(p);
    }
    flat.sort((a, b) => a.run.baseline.start.y - b.run.baseline.start.y || a.run.baseline.start.x - b.run.baseline.start.x);
    let current: { y: number; h: number; pieces: Piece[] } | null = null;
    for (const p of flat) {
      const y = p.run.baseline.start.y;
      const h = heightOf(p);
      if (current && Math.abs(y - current.y) <= Math.min(h, current.h) / 2) {
        current.pieces.push(p);
        current.h = Math.min(current.h, h);
      } else {
        current = { y, h, pieces: [p] };
        lines.push(current);
      }
    }
    lines.sort((a, b) => a.y - b.y);
    for (const l of lines) {
      const pieces = l.pieces.sort((a, b) => a.run.baseline.start.x - b.run.baseline.start.x);
      const joined = pieces.map((p, k) => {
        if (k === 0) return false;
        const prev = pieces[k - 1];
        const gap = p.run.baseline.start.x - prev.run.baseline.end.x;
        return gap > 0.15 * Math.min(heightOf(p), heightOf(prev));
      });
      const text = pieces.map((p, k) => (joined[k] ? ' ' : '') + p.text).join('');
      all.push({ text, pieces, joined });
    }
  }
  return all;
}

const MAX_SECTION_CHARS = 6_000;
const MAX_LINE = 400;
const MAX_CHANGED = 12;

const shown = (s: string, max = MAX_LINE) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

// Why the text may be off, from the runs the lines are made of; and what the
// answer left out.
function notes(read: CanvasRead, lines: Line[]): string[] {
  const out: string[] = [];
  const reasons = new Set<string>();
  for (const l of lines) for (const p of l.pieces) if (!p.run.exact) reasons.add(p.run.inexact ?? 'inexact');
  if (reasons.size) out.push(`Some of this text is not exact (${[...reasons].join(', ')}): its places may be off.`);
  if (read.canvases.some((c) => c.truncated)) out.push('A canvas holds more than its record keeps (truncated): its oldest text is missing.');
  if (read.runsCut) out.push(`${read.runsCut} run(s) were left out past the answer's cap.`);
  if (read.framesLeftOut?.length) out.push(`${read.framesLeftOut.length} frame(s) did not answer; their canvases are left out.`);
  return out;
}

// The section a listing ends with; none when no canvas in view shows text.
export function canvasSection(read: CanvasRead, lines: Line[]): string[] {
  if (!lines.length) return [];
  const out = ['', 'Canvas text in view:'];
  let size = 0;
  let n = 0;
  for (const l of lines) {
    const line = `  ${shown(l.text)}`;
    if (size + line.length > MAX_SECTION_CHARS) break;
    out.push(line);
    size += line.length + 1;
    n++;
  }
  if (n < lines.length) out.push(`  … ${lines.length - n} more lines`);
  out.push(...notes(read, lines));
  return out;
}

// What changed between two reads, compared as text: a line that only moved
// is not a change. More than 12 changed lines (a scroll) become one line.
export function canvasChange(before: string[], lines: Line[]): string[] {
  const now = lines.map((l) => l.text);
  const left = new Map<string, number>();
  for (const t of now) left.set(t, (left.get(t) ?? 0) + 1);
  const removed: string[] = [];
  for (const t of before) {
    const k = left.get(t) ?? 0;
    if (k) left.set(t, k - 1);
    else removed.push(t);
  }
  const was = new Map<string, number>();
  for (const t of before) was.set(t, (was.get(t) ?? 0) + 1);
  const added: string[] = [];
  for (const t of now) {
    const k = was.get(t) ?? 0;
    if (k) was.set(t, k - 1);
    else added.push(t);
  }
  if (!removed.length && !added.length) return [];
  if (removed.length + added.length > MAX_CHANGED) {
    if (!now.length) return ['', 'Canvas text: none shows in view now.'];
    return [
      '',
      `Canvas text in view changed: ${now.length} line(s) show now, from ${JSON.stringify(shown(now[0], 120))} to ${JSON.stringify(shown(now.at(-1)!, 120))}.`,
    ];
  }
  return [
    '',
    'Canvas text changed:',
    ...removed.map((t) => `  - ${shown(t)}`),
    ...added.map((t) => `  + ${shown(t)}`),
  ];
}

// --- aiming by text -----------------------------------------------------

// A place in a piece's text: before its character `ci`.
interface At {
  piece: Piece;
  ci: number;
}

// One character of the flow: the lines' text, one space where two runs were
// joined and one between a line and the next, every run of whitespace one
// space. `start` is the place before it and `end` the place after it: for a
// space that stands for a gap, the end of the run before and the start of
// the run after.
interface FlowChar {
  ch: string;
  start: At;
  end: At;
}

const WHITESPACE = /\s/;

function flowOf(lines: Line[]): FlowChar[] {
  const flow: FlowChar[] = [];
  let prev: Piece | null = null;
  const push = (c: FlowChar) => {
    const last = flow.at(-1);
    if (c.ch === ' ' && last?.ch === ' ') last.end = c.end;
    else flow.push(c);
  };
  for (const line of lines) {
    line.pieces.forEach((p, k) => {
      // A gap: between two runs joined by a space, and between two lines.
      if (prev && (k > 0 ? line.joined[k] : true)) {
        push({ ch: ' ', start: { piece: prev, ci: prev.text.length }, end: { piece: p, ci: 0 } });
      }
      for (let ci = 0; ci < p.text.length; ci++) {
        const ch = WHITESPACE.test(p.text[ci]) ? ' ' : p.text[ci];
        push({ ch, start: { piece: p, ci }, end: { piece: p, ci: ci + 1 } });
      }
      prev = p;
    });
  }
  return flow;
}

export const normalise = (s: string) => [...s].filter((c) => !FORMAT.test(c)).join('').replace(/\s+/g, ' ');

// The place at flow boundary b: before the character after it, unless that
// is a space (the caller's text puts the space after the place), then after
// the character before it.
function placeAt(flow: FlowChar[], b: number): At {
  if (b < flow.length && (flow[b].ch !== ' ' || b === 0)) return flow[b].start;
  return flow[b - 1].end;
}

// The point of a place: the boundary's point along the run (advances), at
// the middle of the run's box in height.
export function pointOf(at: At): Pt {
  const { run, map } = at.piece;
  const i = map[at.ci];
  const f = run.width ? run.advances[i] / run.width : 0;
  const [lt, rt, rb, lb] = run.quad;
  const top = { x: lt.x + (rt.x - lt.x) * f, y: lt.y + (rt.y - lt.y) * f };
  const bottom = { x: lb.x + (rb.x - lb.x) * f, y: lb.y + (rb.y - lb.y) * f };
  return { x: (top.x + bottom.x) / 2, y: (top.y + bottom.y) / 2 };
}

export interface Aim {
  point: Pt;
  run: Run;
  canvas: Canvas;
}

// Finds the one place where `before` ends and the text after begins, or the
// span of `select` with its context. Refused, before anything moves, when no
// place or more than one reads so, or a place's point is out of view, or it
// lies in text whose font changed since its draw.
export function aim(lines: Line[], before: string | undefined, middle: string | undefined, after: string | undefined, what: string): Aim[] {
  const b = normalise(before ?? '');
  const m = middle === undefined ? null : normalise(middle);
  const a = normalise(after ?? '');
  if (m !== null && !m.trim()) throw new ToolError('select names no text to select.');
  if (m === null && !b.trim() && !a.trim()) throw new ToolError('Give text_before or text_after (at least one) with text the canvas shows.');
  const flow = flowOf(lines);
  const text = flow.map((c) => c.ch).join('');
  const needle = b + (m ?? '') + a;
  const found: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) found.push(i);
  if (found.length !== 1) {
    if (!lines.length) throw new ToolError(`No canvas in view shows text, so nothing reads ${what}. Nothing was done. Scroll the text into view, or aim at a point.`);
    throw new ToolError(
      found.length
        ? `${found.length} places in the canvas text in view read ${what}. Nothing was done. Give more text around it (text_before, text_after) so that only one does.`
        : `No place in the canvas text in view reads ${what}. Nothing was done. Scroll it into view, or check the text against observe's "Canvas text in view" (whitespace counts as one space).`,
    );
  }
  const at = found[0] + b.length;
  const bounds = m === null ? [at] : [at, at + m.length];
  return bounds.map((k) => {
    const place = placeAt(flow, k);
    const point = pointOf(place);
    const { run, canvas } = place.piece;
    if (run.inexact === 'fontChanged') {
      throw new ToolError(`The text ${what} was drawn in a font that has changed since (fontChanged), so its boundaries are only estimates. Nothing was done. Aim at a point instead, or wait for the page to draw it again.`);
    }
    const r = canvas.shownRect;
    const inside = !!r && point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height;
    if (!inside) throw new ToolError(`The place at ${what} is not in the part of its canvas the view shows. Nothing was done. Scroll it into view.`);
    return { point, run, canvas };
  });
}

// One cautioning line for a place in text the browser does not vouch for.
export function caution(aims: Aim[]): string | null {
  const reasons = [...new Set(aims.filter((x) => !x.run.exact).map((x) => x.run.inexact ?? 'inexact'))];
  return reasons.length ? `The text there is not exact (${reasons.join(', ')}): the place may be a little off.` : null;
}
