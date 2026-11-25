// Canvas text without a browser, on made-up Page.agentCanvasText answers:
// what a page cannot easily be made to show. A run read fontChanged is
// refused as a place, one partlyCovered acts with a caution; the listing's
// exactness line names the runs' reasons; a rotated run is a line of its
// own; a gap of 0.15 of the box height or less is no space; the section stops
// at about 6,000 characters with a count of the rest; a boundary inside a
// run follows advances (a format character at the run's start included); the
// change lines compare text, so a line that moved is no change.
// Usage: node test/canvas_unit.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-unit-'));
await build({
  entryPoints: [path.resolve(here, '../src/canvas.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: tmp,
  outExtension: { '.js': '.mjs' },
  logLevel: 'error',
});
const cv = await import(pathToFileURL(path.join(tmp, 'canvas.mjs')).href);

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const refusedWith = (fn, re) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(e.message);
  }
};

// A run drawn left to right at (x, y), 10 px per character, a 16 px box;
// U+202D … U+202C around its text, as Google Docs draws.
function run(text, x, y, extra = {}) {
  const raw = '\u202d' + text + '\u202c';
  const advances = [];
  for (let i = 0; i <= raw.length; i++) advances.push(Math.max(0, Math.min(i - 1, text.length)) * 10);
  const w = text.length * 10;
  return {
    text: raw,
    font: '16px Arial',
    baseline: { start: { x, y }, end: { x: x + w, y } },
    width: w,
    advances,
    quad: [{ x, y: y - 12 }, { x: x + w, y: y - 12 }, { x: x + w, y: y + 4 }, { x, y: y + 4 }],
    exact: true,
    ...extra,
  };
}
const canvas = (runs, extra = {}) => ({ context: '2d', shownRect: { x: 0, y: 0, width: 2000, height: 2000 }, exact: true, truncated: false, runs, fills: [], ...extra });
const read = (canvases, extra = {}) => ({ canvases, framesLeftOut: [], runsCut: 0, fillsCut: 0, ...extra });

// Gaps: 4 px (0.25 of 16) is a space, 2 px (0.125) is none.
let r = read([canvas([run('test.', 0, 100), run('Plain', 54, 100), run('ly', 104, 100)])]);
let lines = cv.linesOf(r);
check(lines.length === 1 && lines[0].text === 'test. Plainly', `a gap over 0.15 of the box height is a space, one under it none (${JSON.stringify(lines[0]?.text)})`);

// A boundary inside a run: the format character at its start is skipped.
let aims = cv.aim(lines, 'test. Pl', undefined, 'ain', '"x"');
check(aims.length === 1 && aims[0].point.x === 74 && aims[0].point.y === 96, `a boundary inside a run is at its advance, in the box's middle (${JSON.stringify(aims[0]?.point)})`);
// The gap, both ways.
aims = cv.aim(lines, 'test.', undefined, ' Plain', '"x"');
check(aims[0].point.x === 50, `a space after the place: the end of the run before (${aims[0].point.x})`);
aims = cv.aim(lines, 'test. ', undefined, 'Plain', '"x"');
check(aims[0].point.x === 54, `a space before the place: the start of the run after (${aims[0].point.x})`);

// Order: lines top to bottom; a rotated run is a line of its own.
const rotated = run('Side', 300, 50);
rotated.baseline = { start: { x: 300, y: 50 }, end: { x: 300, y: 90 } };
r = read([canvas([run('second', 0, 140), run('first', 0, 100), rotated])]);
lines = cv.linesOf(r);
check(JSON.stringify(lines.map((l) => l.text)) === JSON.stringify(['Side', 'first', 'second']), `lines read top to bottom, the rotated run alone (${JSON.stringify(lines.map((l) => l.text))})`);
// A non-2D canvas carries no lines.
check(cv.linesOf(read([{ ...canvas([run('gl', 0, 10)]), context: 'webgl' }])).length === 0, 'a WebGL canvas gives no lines');

// fontChanged is refused; partlyCovered acts with a caution.
r = read([canvas([run('estimated', 0, 100, { exact: false, inexact: 'fontChanged' }), run('covered', 0, 140, { exact: false, inexact: 'partlyCovered' })], { exact: false })]);
lines = cv.linesOf(r);
check(refusedWith(() => cv.aim(lines, 'esti', undefined, 'mated', '"esti" then "mated"'), /fontChanged.*Nothing was done/), 'a place in a run read fontChanged is refused');
aims = cv.aim(lines, 'cov', undefined, undefined, '"cov"');
check(/not exact \(partlyCovered\)/.test(cv.caution(aims) ?? ''), `a place in a partly covered run gets a caution (${cv.caution(aims)})`);
const section = cv.canvasSection(r, lines).join('\n');
check(/Some of this text is not exact \(fontChanged, partlyCovered\)/.test(section), `the section names the runs' reasons (${JSON.stringify(section)})`);
// A canvas inexact only for its fills gives no line.
r = read([canvas([run('fine', 0, 100)], { exact: false })]);
check(!/not exact/.test(cv.canvasSection(r, cv.linesOf(r)).join('\n')), 'a canvas inexact for a fill alone gets no exactness line');
r = read([canvas([run('fine', 0, 100)], { truncated: true })], { runsCut: 7, framesLeftOut: ['F1'] });
const cutNotes = cv.canvasSection(r, cv.linesOf(r)).join('\n');
check(/truncated/.test(cutNotes) && /7 run\(s\) were left out/.test(cutNotes) && /1 frame\(s\) did not answer/.test(cutNotes), 'truncated, runsCut and framesLeftOut are each told');

// Out of the shown part: refused.
r = read([canvas([run('hidden', 0, 100)], { shownRect: { x: 0, y: 0, width: 2000, height: 50 } })]);
check(refusedWith(() => cv.aim(cv.linesOf(r), undefined, undefined, 'hidden', '"hidden"'), /not in the part of its canvas the view shows/), 'a place outside the shown part is refused');

// The section stops at about 6,000 characters.
const many = [];
for (let i = 0; i < 200; i++) many.push(run(`Line ${String(i).padStart(3, '0')} ${'x'.repeat(40)}`, 0, 100 + i * 20));
r = read([canvas(many)]);
const big = cv.canvasSection(r, cv.linesOf(r));
const size = big.join('\n').length;
check(size < 6_300 && /^ {2}… \d+ more lines$/.test(big.at(-1)), `the section stops near 6,000 characters (${size}) and counts the rest (${big.at(-1)})`);

// Changes: compared as text; a moved line is none; more than 12 is a summary.
const before = ['one', 'two', 'three'];
const moved = cv.linesOf(read([canvas([run('three', 0, 100), run('one', 0, 120), run('two', 0, 140)])]));
check(cv.canvasChange(before, moved).length === 0, 'lines that only moved are no change');
const edited = cv.linesOf(read([canvas([run('one', 0, 100), run('two!', 0, 120), run('three', 0, 140)])]));
check(JSON.stringify(cv.canvasChange(before, edited)) === JSON.stringify(['', 'Canvas text changed:', '  - two', '  + two!']), `one edited line: - and + (${JSON.stringify(cv.canvasChange(before, edited))})`);
const scrolled = cv.linesOf(read([canvas(many.slice(0, 20))]));
const sum = cv.canvasChange(before, scrolled);
check(sum.length === 2 && /^Canvas text in view changed: 20 line\(s\) show now, from "Line 000 x+" to "Line 019 x+"\.$/.test(sum[1]), `more than 12 changed lines are one summary (${sum[1]})`);

// Outlined text (strokeText + fillText at the same spot, e.g. Desmos / ECharts)
// is listed once, preferring the fill; pure strokeText stays; adjacent
// identical runs ("0" + "0" -> "00") are not merged; rotated outlined text
// is also deduplicated.
const rawRun = (text, x, y, extra = {}) => {
  const advances = [];
  for (let i = 0; i <= text.length; i++) advances.push(i * 10);
  const w = text.length * 10;
  return {
    text,
    font: '16px Arial',
    baseline: { start: { x, y }, end: { x: x + w, y } },
    width: w,
    advances,
    quad: [{ x, y: y - 12 }, { x: x + w, y: y - 12 }, { x: x + w, y: y + 4 }, { x, y: y + 4 }],
    exact: true,
    ...extra,
  };
};
const rotStroke = rawRun('Axis', 300, 50, { stroke: true });
rotStroke.baseline = { start: { x: 300, y: 50 }, end: { x: 300, y: 90 } };
const rotFill = rawRun('Axis', 300, 50, { stroke: false });
rotFill.baseline = { start: { x: 300, y: 50 }, end: { x: 300, y: 90 } };
r = read([canvas([
  rawRun('14', 10, 100, { stroke: true, exact: false, inexact: 'notFollowed' }),
  rawRun('14', 10, 100, { stroke: false, exact: true }),
  rawRun('Email', 60, 100, { stroke: false }),
  rawRun('Email', 60, 100, { stroke: true }),
  rawRun('Hollow', 140, 100, { stroke: true }),
  rawRun('0', 220, 100),
  rawRun('0', 230, 100),
  rotStroke,
  rotFill,
])]);
lines = cv.linesOf(r);
check(
  JSON.stringify(lines.map((l) => l.text)) === JSON.stringify(['Axis', '14 Email Hollow 00']) &&
    lines[1].pieces[0].run.stroke === false &&
    lines[1].pieces[0].run.exact === true,
  `outlined text collapses to one preferring fill, pure stroke and side-by-side "00" stay (${JSON.stringify(lines.map((l) => l.text))})`,
);

// Private-use code points (PDF.js U+E0xx, icon glyphs, supplementary PUA) and
// alpha: 0 runs are dropped, while real text after a PUA glyph keeps its map.
const iconPrefix = rawRun('\uF007Profile', 20, 100);
r = read([canvas([
  rawRun('\uE012', 10, 80),
  rawRun('\uE013', 20, 80),
  rawRun('\u{F0001}', 30, 80),
  rawRun('Ghost', 10, 140, { alpha: 0 }),
  iconPrefix,
])]);
lines = cv.linesOf(r);
aims = cv.aim(lines, 'Pro', undefined, 'file', '"Pro|file"');
check(
  lines.length === 1 && lines[0].text === 'Profile' && aims[0].point.x === 60,
  `PUA and alpha:0 runs are dropped and advances map stays exact (${JSON.stringify(lines.map((l) => l.text))}, x=${aims[0]?.point.x})`,
);

// Zero-width spaces (canvas-editor starts lines with U+200B), BOM, word joiner
// and soft hyphen are stripped in both piece() and normalise(), so cross-line
// aiming matches; emoji ZWJ (U+200D) stays intact.
r = read([canvas([
  rawRun('\u200BFirst line', 10, 100),
  rawRun('\u200BSecond\u00AD line', 10, 124),
  rawRun('\u200B', 10, 148),
  rawRun('Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}', 10, 172),
])]);
lines = cv.linesOf(r);
aims = cv.aim(lines, 'line ', undefined, 'Second', '"line |Second"');
check(
  JSON.stringify(lines.map((l) => l.text)) === JSON.stringify(['First line', 'Second line', 'Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}']) &&
    aims[0].point.x === 20,
  `U+200B/soft-hyphen stripped for cross-line aiming, empty U+200B line dropped, ZWJ kept (${JSON.stringify(lines.map((l) => l.text))}, x=${aims[0]?.point.x})`,
);

// untrackedBitmap: noted both when no text was tracked and alongside tracked text.
const untrackedEmpty = {
  canvases: [{ context: '2d', shownRect: { x: 0, y: 0, width: 800, height: 600 }, exact: false, truncated: false, untrackedBitmap: true, runs: [] }],
  framesLeftOut: [],
  runsCut: 0,
};
const secEmpty = cv.canvasSection(untrackedEmpty, cv.linesOf(untrackedEmpty));
check(
  secEmpty.length === 2 && /untrackedBitmap/.test(secEmpty[1]),
  `untrackedBitmap with no tracked runs still surfaces a note (${JSON.stringify(secEmpty)})`,
);
const untrackedWithText = {
  canvases: [{ context: '2d', shownRect: { x: 0, y: 0, width: 800, height: 600 }, exact: false, truncated: false, untrackedBitmap: true, runs: [run('Label', 20, 40)] }],
  framesLeftOut: [],
  runsCut: 0,
};
const secWithText = cv.canvasSection(untrackedWithText, cv.linesOf(untrackedWithText)).join('\n');
check(
  secWithText.includes('  Label') && /untrackedBitmap/.test(secWithText),
  'untrackedBitmap with tracked runs appends the note to the section',
);
const untrackedWebgl = {
  canvases: [{ context: 'webgl2', shownRect: { x: 0, y: 0, width: 800, height: 600 }, exact: false, truncated: false, untrackedBitmap: true, runs: [] }],
  framesLeftOut: [],
  runsCut: 0,
};
check(
  cv.canvasSection(untrackedWebgl, cv.linesOf(untrackedWebgl)).length === 0,
  'non-2d untrackedBitmap canvas does not emit a note',
);
const transparentColor = {
  canvases: [{
    context: '2d',
    shownRect: { x: 0, y: 0, width: 800, height: 600 },
    exact: true,
    truncated: false,
    runs: [
      { ...run('Invisible', 20, 40), color: 'rgba(0, 0, 0, 0)' },
      { ...run('AlsoInvisible', 20, 60), color: 'transparent' },
      { ...run('Visible', 20, 80), color: 'rgba(0, 0, 0, 0.5)' },
    ],
  }],
  framesLeftOut: [],
  runsCut: 0,
};
check(
  JSON.stringify(cv.linesOf(transparentColor).map((l) => l.text)) === JSON.stringify(['Visible']),
  'transparent / rgba(..., 0) color runs are dropped',
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
