// WITHDRAWN (2026-11-02): this script's reading of the net log is wrong. It
// reported that Chromaphore issues no HTTPS-record queries; it does, exactly as
// stock Chrome, and both give up on the answer after a short extra wait (the
// stock-Chrome findings fork's research\ech.md and its
// research\probes\netlog_dns_probe.mjs do this properly). Kept as a record.
//
// Why the fork does not use ECH where stock Chrome does: loads Cloudflare's
// trace in each browser with --log-net-log and reports, from the log, which
// resolver answered (the built-in DNS client or the system's), whether an
// HTTPS record was asked for, and the secure DNS mode the resolver ran with.
// Usage: node spike_ech_netlog.mjs [fork chrome.exe] [stock chrome.exe]
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

for (const [label, exe, extra] of [
  ['stock Chrome', stock, ['--no-first-run', '--no-default-browser-check']],
  ['Chromaphore', fork, []],
]) {
  const profile = path.join(scratch, 'profiles', `netlog-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const log = path.join(scratch, `netlog-${label.replace(/\W+/g, '-')}.json`);
  const cdp = launchPipe(exe, [`--user-data-dir=${profile}`, '--headless=new', `--log-net-log=${log}`, ...extra]);
  try {
    const { sessionId } = await openTab(cdp);
    await cdp.send('Page.navigate', { url: 'https://crypto.cloudflare.com/cdn-cgi/trace' }, sessionId);
    await new Promise((r) => setTimeout(r, 4000));
    const t = await cdp.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sessionId);
    console.log(`${label}: ${/sni=\w+/.exec(t.result.value ?? '')?.[0]}`);
  } finally {
    await cdp.send('Browser.close').catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    spawnSync('taskkill', ['/PID', String(cdp.proc.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  const text = fs.readFileSync(log, 'utf8');
  const constants = JSON.parse(text.slice(0, text.indexOf('"events"') - 1).replace(/,\s*$/, '') + '}').constants;
  const typeName = Object.fromEntries(Object.entries(constants.logEventTypes).map(([k, v]) => [v, k]));
  const counts = {};
  const notes = new Set();
  for (const line of text.split('\n')) {
    const m = /"type":(\d+)/.exec(line);
    if (!m) continue;
    const name = typeName[m[1]] ?? m[1];
    if (/HOST_RESOLVER/.test(name) && line.includes('crypto.cloudflare.com')) counts[name] = (counts[name] ?? 0) + 1;
    if (/HOST_RESOLVER_(DNS|SYSTEM)_TASK|DNS_TRANSACTION|HOST_RESOLVER_MANAGER_JOB\b/.test(name)) counts[name] = (counts[name] ?? 0) + 1;
    for (const k of ['"secure_dns_mode":\\d+', '"dns_query_type":\\d+', '"query_type":"?\\w+"?', '"insecure_dns_client_enabled":\\w+', '"additional_dns_types_enabled":\\w+']) {
      const mm = new RegExp(k).exec(line);
      if (mm) notes.add(mm[0]);
    }
  }
  console.log('  events:', JSON.stringify(counts));
  console.log('  fields seen:', [...notes].sort().join(' '));
}
fs.rmSync(path.join(scratch, 'profiles'), { recursive: true, force: true });
