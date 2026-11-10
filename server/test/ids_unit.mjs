// Pure pieces of the id scheme, without a browser: the settle line leaves the
// browser's labels out of element names (and leaves request hosts alone), and
// page letters run a, b, ... r, u, ... z, aa, never s or t (the letters of
// snapshot and tab ids).
// Usage: node test/ids_unit.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ids-unit-'));
await build({
  entryPoints: ['listing', 'browser'].map((m) => path.resolve(here, `../src/${m}.ts`)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: tmp,
  outExtension: { '.js': '.mjs' },
  logLevel: 'error',
});
const { settleLine } = await import(pathToFileURL(path.join(tmp, 'listing.mjs')).href);
const { Browser } = await import(pathToFileURL(path.join(tmp, 'browser.mjs')).href);

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

const line = (kind, what) => settleLine({ settle: { settled: false, afterMs: 1200, stillChanging: [{ kind, what }] } });
const cases = [
  ['mutation', 'a12 "Save" (gone)', 'mutation "Save" (gone)'],
  ['mutation', 'a12 (changed)', 'mutation a listed element (changed)'],
  ['mutation', 'div#a12 (new)', 'mutation div#a12 (new)'],
  ['animation', 'transition opacity on a12 "Save" (0.4s left)', 'animation transition opacity on "Save" (0.4s left)'],
  ['animation', 'transition opacity on a7 (0.4s left)', 'animation transition opacity on a listed element (0.4s left)'],
  ['animation', 'spin 1.2s (a3 "Loading")', 'animation spin 1.2s ("Loading")'],
  ['request', 'a248.e.akamai.net/x.js', 'request a248.e.akamai.net/x.js'],
  // Only the label the browser put in, not text of the name that looks like one.
  ['mutation', 'a12 "Sizes (a4 "small")" (gone)', 'mutation "Sizes (a4 "small")" (gone)'],
  ['mutation', 'a12 "Turn on a5 "fan"" (gone)', 'mutation "Turn on a5 "fan"" (gone)'],
  ['animation', 'transition opacity on a12 "Turn on a5 "fan""', 'animation transition opacity on "Turn on a5 "fan""'],
  ['animation', 'spin infinite on a9', 'animation spin infinite on a listed element'],
  ['animation', 'spin 1.2s (a3)', 'animation spin 1.2s (a listed element)'],
];
for (const [kind, what, want] of cases) {
  const got = line(kind, what);
  check(got.includes(`still changing ${want}.`), `${kind} ${JSON.stringify(what)} -> ${JSON.stringify(got.replace(/^.*still changing /, ''))}`);
}

// Letters, on two stand-in browsers: the count is the server's, so the second
// browser goes on from where the first stopped.
const first = Object.create(Browser.prototype);
const second = Object.create(Browser.prototype);
const seq = Array.from({ length: 27 }, (_, i) => first.lettersFor('t1', `d${i}`));
check(seq.slice(0, 18).join('') === 'abcdefghijklmnopqr', `letters a to r: ${seq.slice(0, 18).join(' ')}`);
check(!seq.includes('s') && !seq.includes('t') && seq[18] === 'u', `s and t skipped: ${seq.slice(17, 21).join(' ')}`);
check(seq[24] === 'aa' && seq[26] === 'ac', `then aa: ${seq.slice(23).join(' ')}`);
check(first.lettersFor('t1', 'd3') === 'd', 'a page shown again keeps its letters');
check(second.lettersFor('t1', 'd0') === 'ad', 'a second browser goes on with the next letters, not a');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
