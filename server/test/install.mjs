// Runs browser_install through the bundled server as Claude Code would, with
// progress notifications, then launches what it installed.
// Usage: node test/install.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
delete env.CHROMAPHORE_BROWSER;
const client = new Client({ name: 'install-test', version: '0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(here, '../../plugin/dist/server.mjs')],
    env,
    stderr: 'inherit',
  }),
);

const t0 = Date.now();
let lastTenth = -1;
const r = await client.callTool({ name: 'browser_install', arguments: {} }, undefined, {
  timeout: 120_000,
  resetTimeoutOnProgress: true,
  maxTotalTimeout: 3_600_000,
  onprogress: (p) => {
    const tenth = Math.floor((10 * p.progress) / (p.total || 1));
    if (tenth !== lastTenth) {
      lastTenth = tenth;
      console.log(`${Math.round((Date.now() - t0) / 1000)} s: ${p.message}`);
    }
  },
});
console.log(`browser_install after ${Math.round((Date.now() - t0) / 1000)} s: ${r.isError ? 'ERROR ' : ''}${r.content[0].text}`);

if (!r.isError) {
  for (const [name, args] of [
    ['browser_open', { headless: true, url: 'about:blank' }],
    ['browser_close', {}],
  ]) {
    const a = await client.callTool({ name, arguments: args });
    console.log(`${name}: ${a.isError ? 'ERROR ' : ''}${a.content[0].text.split('\n').slice(0, 4).join(' | ')}`);
  }
}
await client.close();
