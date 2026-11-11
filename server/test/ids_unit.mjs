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
// Each copy is a fresh module, as a fresh server process is.
async function bundle(dir) {
  await build({
    entryPoints: ['listing', 'browser'].map((m) => path.resolve(here, `../src/${m}.ts`)),
    bundle: true,
    platform: 'node',
    format: 'esm',
    outdir: path.join(tmp, dir),
    outExtension: { '.js': '.mjs' },
    logLevel: 'error',
  });
  return {
    listing: await import(pathToFileURL(path.join(tmp, dir, 'listing.mjs')).href),
    browser: await import(pathToFileURL(path.join(tmp, dir, 'browser.mjs')).href),
  };
}
// No session: the count is this process's.
delete process.env.CLAUDE_CODE_SESSION_ID;
const plain = await bundle('plain');
const { settleLine } = plain.listing;
const { Browser } = plain.browser;
const stand = (B) => Object.assign(Object.create(B.prototype), { notices: [] });

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
  // Names holding " (a1)" or " on " (found by the NoDriver session, 2026-11-10).
  ['animation', 'spin (a12 "Plan (a1) x")', 'animation spin ("Plan (a1) x")'],
  ['animation', 'spin (a12 "Turn on fan")', 'animation spin ("Turn on fan")'],
  ['animation', 'transition opacity on div#x (0.4s left)', 'animation transition opacity on div#x (0.4s left)'],
  // A parenthesised name holding " on aN" (the 0.2.3 review, 2026-11-11).
  ['animation', 'spin 1.2s (a12 "Seat on a5 (window)")', 'animation spin 1.2s ("Seat on a5 (window)")'],
  ['animation', 'spin (a12 "Turn on a5 "fan"")', 'animation spin ("Turn on a5 "fan"")'],
];
for (const [kind, what, want] of cases) {
  const got = line(kind, what);
  check(got.includes(`still changing ${want}.`), `${kind} ${JSON.stringify(what)} -> ${JSON.stringify(got.replace(/^.*still changing /, ''))}`);
}

// Letters, on two stand-in browsers: the count is the server's, so the second
// browser goes on from where the first stopped.
const first = stand(Browser);
const second = stand(Browser);
const seq = Array.from({ length: 27 }, (_, i) => first.lettersFor('t1', `d${i}`));
check(seq.slice(0, 18).join('') === 'abcdefghijklmnopqr', `letters a to r: ${seq.slice(0, 18).join(' ')}`);
check(!seq.includes('s') && !seq.includes('t') && seq[18] === 'u', `s and t skipped: ${seq.slice(17, 21).join(' ')}`);
check(seq[24] === 'aa' && seq[26] === 'ac', `then aa: ${seq.slice(23).join(' ')}`);
check(first.lettersFor('t1', 'd3') === 'd', 'a page shown again keeps its letters');
check(second.lettersFor('t1', 'd0') === 'ad', 'a second browser goes on with the next letters, not a');

// One Claude Code session, its server started twice (a restart under a live
// session): the second goes on from the saved count, so an id the model holds
// from before names no page of the new one. The count lives under a scratch
// %LOCALAPPDATA%.
process.env.LOCALAPPDATA = path.join(tmp, 'local');
process.env.CLAUDE_CODE_SESSION_ID = 'unit-test-session';
const before = (await bundle('session-1')).browser;
const was = ['p1', 'p2', 'p3'].map((d) => stand(before.Browser).lettersFor('t1', d));
const after = (await bundle('session-2')).browser;
const now = stand(after.Browser).lettersFor('t9', 'p1');
const file = path.join(tmp, 'local', 'Chromaphore', 'ids', 'unit-test-session.json');
check(was.join('') === 'abc' && now === 'd', `a restarted server of the same session goes on: ${was.join(' ')}, then ${now}`);
check(JSON.parse(fs.readFileSync(file, 'utf8')).next === 4, 'the count is saved before the letters go out');
process.env.CLAUDE_CODE_SESSION_ID = 'another-session';
const other = (await bundle('session-3')).browser;
check(stand(other.Browser).lettersFor('t1', 'p1') === 'a', 'another session starts at a');
const ids = path.join(tmp, 'local', 'Chromaphore', 'ids');
check(!fs.readdirSync(ids).some((f) => /\.(part|lock)$/.test(f)), `no .part or .lock left: ${fs.readdirSync(ids).join(' ')}`);

// A count that cannot be read: the letters go on from the process's count
// and the next reply says so once, rather than the reply failing.
process.env.CLAUDE_CODE_SESSION_ID = 'corrupt-session';
fs.writeFileSync(path.join(ids, 'corrupt-session.json'), '{');
const broken = (await bundle('session-4')).browser;
const hurt = stand(broken.Browser);
const l1 = hurt.lettersFor('t1', 'p1');
const l2 = hurt.lettersFor('t1', 'p2');
check(l1 === 'a' && l2 === 'b', `letters go on from the process's count: ${l1} ${l2}`);
check(hurt.notices.length === 1 && /could not keep its count of page ids \(the saved count was unreadable\)/.test(hurt.notices[0]), `told once, plainly: ${hurt.notices[0]}`);
check(JSON.parse(fs.readFileSync(path.join(ids, 'corrupt-session.json'), 'utf8')).next === 2, 'the unreadable count is replaced, so later servers go on from it');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
