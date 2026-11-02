// What --disable-features=UseDnsHttpsSvcb changes on the wire, against stock
// Chrome: Encrypted Client Hello (Cloudflare's trace says sni=encrypted or
// plaintext) and the TLS fingerprint browserleaks.com reports (JA3/JA4, the
// HTTP/2 fingerprint). Each page is loaded twice; the second load may use a
// DNS HTTPS record the first one fetched.
// Usage: node spike_ech.mjs [fork chrome.exe] [stock chrome.exe]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EXE, launchPipe, openTab } from './cdp_pipe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, '../../.scratch');
const exes = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const fork = exes[0] ?? DEFAULT_EXE;
const stock = exes[1] ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SETUPS = process.argv.includes('--why')
  ? [
      // Narrowing down why the fork does not use ECH.
      ['Chromeleon, --use-chromium-defaults (no preset)', fork, ['--use-chromium-defaults']],
      ['Chromeleon, AsyncDns forced on', fork, ['--enable-features=AsyncDns']],
      ['stock Chrome, AsyncDns off', stock, ['--no-first-run', '--no-default-browser-check', '--disable-features=AsyncDns']],
    ]
  : [
      ['stock Chrome', stock, ['--no-first-run', '--no-default-browser-check']],
      ['Chromeleon', fork, []],
      ['Chromeleon, UseDnsHttpsSvcb off', fork, ['--disable-features=UseDnsHttpsSvcb']],
    ];

async function bodyText(cdp, sessionId, url) {
  const committed = new Promise((resolve) => {
    const off = cdp.on((m) => {
      if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') {
        off();
        resolve();
      }
    });
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  await Promise.race([committed, new Promise((r) => setTimeout(r, 15000))]);
  const r = await cdp.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sessionId);
  return r.result.value ?? '';
}

for (const [label, exe, extra] of SETUPS) {
  const profile = path.join(scratch, 'profiles', `ech-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const cdp = launchPipe(exe, [`--user-data-dir=${profile}`, '--headless=new', ...extra]);
  try {
    const v = await cdp.send('Browser.getVersion', {}, undefined, 20000);
    const { sessionId } = await openTab(cdp);
    await cdp.send('Page.enable', {}, sessionId);
    const traces = [];
    for (let i = 0; i < 2; i++) {
      const t = await bodyText(cdp, sessionId, 'https://crypto.cloudflare.com/cdn-cgi/trace');
      const kv = Object.fromEntries(t.split('\n').map((l) => l.split('=')));
      traces.push(`sni=${kv.sni} tls=${kv.tls} http=${kv.http}`);
    }
    let tls = {};
    try {
      tls = JSON.parse(await bodyText(cdp, sessionId, 'https://tls.browserleaks.com/json'));
    } catch (e) {
      tls = { error: e.message };
    }
    console.log(`${label} (${v.product})`);
    console.log(`  cloudflare trace, 1st load: ${traces[0]}`);
    console.log(`  cloudflare trace, 2nd load: ${traces[1]}`);
    console.log(`  ja4 ${tls.ja4} · ja3 ${tls.ja3_hash} · h2 ${tls.akamai_hash}${tls.error ? ` (${tls.error})` : ''}`);
  } catch (e) {
    console.log(`${label}: FAIL ${e.message}`);
  } finally {
    await cdp.send('Browser.close').catch(() => {});
    spawnSync('taskkill', ['/PID', String(cdp.proc.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}
fs.rmSync(path.join(scratch, 'profiles'), { recursive: true, force: true });
