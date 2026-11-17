// Pure pieces of bursts and points, without a browser: the text check (what
// press steps count as, which are refused), the account a burst gives when a
// step fails after keys went out, and the scale of a kept screenshot.
// Usage: node test/bursts_unit.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bursts-unit-'));
await build({
  entryPoints: [path.resolve(here, '../src/actions.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: tmp,
  outExtension: { '.js': '.mjs' },
  logLevel: 'error',
});
const act = await import(pathToFileURL(path.join(tmp, 'actions.mjs')).href);

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

// The text check.
const plan = (keys) => act.planBurst(keys);
check(act.textCheck(plan(['one', { press: 'Enter' }, 'two']), 'one\ntwo') === null, 'a plain Enter counts as a newline');
check(act.textCheck(plan(['a', { press: 'Tab' }, 'b', { press: 'Space' }]), 'a\tb ') === null, 'a plain Tab and Space count as what they type');
check(act.textCheck(plan(['abc', { press: 'Backspace' }]), 'ab') === null, 'a plain Backspace counts as one bs');
check(act.textCheck(plan(['a', { press: 'Ctrl+I' }, 'b', { press: 'Alt+X' }]), 'ab') === null, 'Ctrl+I and an Alt chord are trusted');
for (const p of ['ArrowLeft', 'Shift+ArrowLeft', 'Delete', 'Escape', 'Shift+Enter', 'Ctrl+A', 'Ctrl+V', 'Meta+Z', 'Ctrl+Y', 'Ctrl+Backspace', 'Ctrl+Shift+Home', 'Ctrl+End', 'Ctrl+Enter', 'x']) {
  const refused = act.textCheck(plan(['ab', { press: p }]), 'ab');
  check(/cannot follow .*Leave text out/.test(refused ?? ''), `with text, {"press": "${p}"} is refused`);
}
check(/keys leave "ab\\n"/.test(act.textCheck(plan(['ab', { press: 'Enter' }]), 'ab') ?? ''), 'a refusal shows a newline as \\n');
check(/delete 1 character\(s\) from before the burst/.test(act.textCheck(plan(['a', { bs: 2 }]), '') ?? ''), 'a reach-back is refused with text');
const left = act.burstText(plan(['a', { bs: 2 }, { press: 'ArrowLeft' }]));
check(left.reachesBack === 1 && left.unfollowed.length === 1, 'without text the reach-back and the unfollowed press are counted');
check(refusedWith(() => plan(['a', { press: 'Ctrl+Foo' }]), /step 2 .*not a key/), 'a press naming no key is refused with its step');
check(refusedWith(() => plan([{ press: 'Super+A' }]), /Unknown modifier/), 'an unknown modifier is refused');
check(act.chordOf('F5').key === 'F5' && act.chordOf('Ctrl++').key === '+' && act.chordOf('Ctrl+Shift+Left').modifiers === 10, 'chords parse as before');

// A step that fails after keys went out stops the burst with an account.
const sent = [];
const r = await act.playBurst(plan(['ab', { bs: 2 }, { press: 'Ctrl+I' }, 'cd']), {
  speed: 3,
  seed: 1,
  keystrokes: async (text, typos, part, readBack) => {
    sent.push(`text ${text} readBack=${readBack}`);
    return {};
  },
  chord: async (key) => {
    if (key === 'i') throw new Error('the browser said no');
    sent.push(`chord ${key}`);
  },
});
check(r.failed === 'the browser said no' && r.at === 2 && r.counts === '2 character(s), 2 Backspace(s)', `a failing third step stops the burst with what went out (${JSON.stringify(r)})`);
check(!sent.some((s) => s.startsWith('text cd')), 'nothing after the failed step went out');
check(sent[0] === 'text ab readBack=false', 'a string that is not the last step does not read back');
sent.length = 0;
await act.playBurst(plan(['ab', 'cd']), { speed: 3, seed: 1, keystrokes: async (t, ty, p, rb) => (sent.push(rb), {}), chord: async () => {} });
check(sent.join() === 'false,true', 'only the last string reads the field back');
const ac = new AbortController();
const stopped = await act.playBurst(plan(['ab', { pause_ms: 5000 }, 'cd']), {
  speed: 1,
  seed: 1,
  signal: ac.signal,
  keystrokes: async () => (setTimeout(() => ac.abort(), 50), {}),
  chord: async () => {},
});
check(stopped.cancelled && stopped.at === 1, `a cancel during a pause ends the burst at once (${JSON.stringify(stopped)})`);

// A shortcut's key is one printable ASCII character or a named key: the
// browser's chord fails on any other character, midway through a burst.
for (const k of ['Ctrl+ö', 'ö', 'Alt+é', 'Ctrl+€', 'Ctrl+😀']) {
  check(refusedWith(() => act.chordOf(k), /must be an ASCII character .* or a named key/), `{"press": "${k}"} is refused before anything is sent`);
}
check(refusedWith(() => plan(['abc', { press: 'Ctrl+ö' }]), /Nothing typed: step 2 .*must be an ASCII character/), 'a burst with Ctrl+ö is refused at its step, before anything');
check(['!', '~', 'a', 'Z', '1', '/', '`', '\\'].every((c) => act.chordOf(`Ctrl+${c}`).key.length === 1), 'every printable ASCII edge (! ~ a Z 1 / ` \\) is still a key');
check(act.chordOf('Space').key === 'Space', 'Space is the named key');

// The burst's gaps: the whole seed is mixed in, so small and neighbouring
// seeds give unrelated first values, not ones pinned near zero.
const firsts = [1, 2, 3].map((seed) => act.seeded(seed)());
console.log(`  first values for seeds 1, 2, 3: ${firsts.map((v) => v.toFixed(4)).join(', ')}`);
const spread = Math.min(...firsts.map((v, i) => Math.min(...firsts.filter((_, j) => j !== i).map((w) => Math.abs(v - w)))));
check(firsts.every((v) => v > 0.02 && v < 0.98) && spread > 0.05, `seeds 1, 2 and 3 give first values away from the ends and apart (closest pair ${spread.toFixed(3)})`);
const many = Array.from({ length: 200 }, (_, i) => act.seeded(i + 1)());
const low = many.filter((v) => v < 0.1).length;
check(low >= 5 && low <= 40, `of seeds 1 to 200, ${low} start below 0.1 (about 20 expected)`);
const big = [2 ** 40, 2 ** 40 + 1, 2 ** 47].map((seed) => act.seeded(seed)());
check(new Set(big.map((v) => v.toFixed(6))).size === 3 && act.seeded(2 ** 40)() !== act.seeded(0)(), 'the high bits of the seed count too');
check(act.seeded(7)() === act.seeded(7)(), 'one seed gives one sequence');

// A failed burst keeps its account when the listing after it throws (unit
// level: the listing is a stand-in that throws as a dead browser's would).
const account = ['The burst stopped at step 2 of 3 ({"press": "Ctrl+I"}): Input.dispatchKeyChord failed: gone. Before it went out 2 character(s); nothing after it.'];
const kept = await act
  .keepAccount(account, async () => {
    throw new Error('The browser is gone');
  })
  .catch((e) => `threw: ${e.message}`);
check(kept.startsWith(account[0]) && /The page could not be listed afterwards: The browser is gone/.test(kept), `the account survives a failing listing (${JSON.stringify(kept)})`);
check((await act.keepAccount(account, async () => 'listed')) === 'listed', 'a listing that works is the answer as before');

// The scale of a kept image.
const id = act.keepImage('AAAA', { letters: 'c', scale: 0.784, view: { width: 1920, height: 945 }, targetId: 'T1' });
const note = act.scaleNote(act.image(id));
check(/The image is 1505x741 pixels of a 1920x945 view \(scale 0.784\)/.test(note ?? ''), `the view note (${note})`);
const one = act.keepImage('AAAA', { letters: 'c', scale: 1, view: { width: 1280, height: 585 }, targetId: 'T1' });
check(act.scaleNote(act.image(one)) === null, 'no note at scale 1');
const tab = { id: 't1', targetId: 'T1', letters: 'c' };
const [pt] = act.pointsOfImage(tab, id, [{ x: 784, y: 392 }]);
check(Math.abs(pt.x - 1000) < 1e-9 && Math.abs(pt.y - 500) < 1e-9, `image pixels are divided by the scale (${JSON.stringify(pt)})`);
check(refusedWith(() => act.pointsOfImage({ ...tab, targetId: 'T2', id: 't2' }, id, [{ x: 1, y: 1 }]), /another tab/), 'another tab is refused');
check(refusedWith(() => act.pointsOfImage({ ...tab, letters: 'd' }, id, [{ x: 1, y: 1 }]), /since left/), 'another page is refused');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
