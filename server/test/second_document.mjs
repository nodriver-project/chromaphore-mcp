// Listing ids across a tab's documents. The browser's labels start again at
// a1 in every document, so the plugin gives each page shown letters of its
// own (a12, b12, ...), looks the label up with Page.agentNodesAlive, and
// refuses an id from a page the tab has left or from another tab, even when
// the new page has an element with the same label.
// Usage: node test/second_document.mjs [server.mjs]
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = process.argv[2] ?? path.resolve(here, '../../plugin/dist/server.mjs');

const page = (title, n, extra = '') => `<!doctype html><title>${title}</title>
${Array.from({ length: n }, (_, i) => `<a href="#l${i}">link ${i}</a>`).join(' ')}
<p id="out">not pressed</p>
<button onclick="document.getElementById('out').textContent='pressed in ${title}'">Press ${title}</button>${extra}`;
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  if (req.url === '/one') res.end(page('one', 30));
  else if (req.url === '/two') res.end(page('two', 5));
  else if (req.url.startsWith('/three')) {
    // Reloads itself, as a cookie banner does, leaving its other ids as they were.
    res.end(page('three', 3, `<button onclick="location.href='/three?again=' + Date.now()">Reload</button>`));
  } else res.end('');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const env = { ...process.env };
delete env.CHROMAPHORE_BROWSER;
const client = new Client({ name: 'second-document-test', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'inherit' }));

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text);
  const text = texts.join('\n');
  console.log(`  ${name} ${JSON.stringify(args)}: ${r.isError ? 'ERROR ' : ''}${(texts[0] ?? '(image)').split('\n')[0]}`);
  return { text, isError: !!r.isError };
}
const pressed = async () => (await call('eval_js', { expression: "document.getElementById('out').textContent" })).text;
const idOf = (listing, role, name) => new RegExp(`^([a-z]+\\d+) ${role} "${name}"`, 'm').exec(listing)?.[1];
const snapshotOf = (text) => /snapshot_id (s\d+)/.exec(text)?.[1];

// Page one.
let r = await call('browser_open', { profile: 'temp', headless: true, url: `${base}/one` });
const oneHigh = idOf(r.text, 'link', 'link 29');
const oneLow = idOf(r.text, 'link', 'link 1');
check(/^a\d+$/.test(oneHigh ?? '') && /^a\d+$/.test(oneLow ?? ''), `the first page's ids start with a (${oneLow}, ${oneHigh})`);
r = await call('click', { id: idOf(r.text, 'button', 'Press one') });
check(!r.isError && (await pressed()).includes('pressed in one'), 'a click on the first page');

// Page two, by navigate.
r = await call('navigate', { url: `${base}/two` });
const twoLow = idOf(r.text, 'link', 'link 1');
check(/^b\d+$/.test(twoLow ?? ''), `the second page's ids start with b (${twoLow})`);
check(twoLow?.slice(1) === oneLow?.slice(1), `the label collides: ${oneLow} on page one and ${twoLow} on page two are both the browser's a${oneLow?.slice(1)}`);
const twoSnapshot = snapshotOf(r.text);
r = await call('click', { id: idOf(r.text, 'button', 'Press two') });
check(!r.isError && (await pressed()).includes('pressed in two'), 'a click on the second page');
r = await call('click', { id: oneLow });
check(r.isError && /page this tab has since left/.test(r.text), `${oneLow} from page one, whose label page two also has, is refused`);
r = await call('click', { id: oneHigh });
check(r.isError && /page this tab has since left/.test(r.text), `${oneHigh} from page one is refused`);
r = await call('click', { id: '5' });
check(r.isError && /not an element id/.test(r.text), 'a bare number is not an id');
r = await call('view', { snapshot_id: twoSnapshot });
check(/badge a5 is b5/.test(r.text), "view says what the second page's badges stand for");

// Page three reloads itself; an id sent after the reload, planned before it, is refused.
r = await call('navigate', { url: `${base}/three` });
const threePress = idOf(r.text, 'button', 'Press three');
r = await call('click', { id: idOf(r.text, 'button', 'Reload') });
r = await call('click', { id: threePress });
check(r.isError && /page this tab has since left/.test(r.text), `${threePress}, sent after the reload with the id from before it, is refused`);
r = await call('observe');
r = await call('click', { id: idOf(r.text, 'button', 'Press three') });
check(!r.isError && (await pressed()).includes('pressed in three'), 'a click by the reloaded page own id');

// Another tab: an id of tab t1 is refused there.
r = await call('tab_new', { url: `${base}/two` });
const tabTwoPress = idOf(r.text, 'button', 'Press two');
r = await call('click', { id: twoLow });
check(r.isError && /element of tab t1/.test(r.text), `${twoLow} of tab t1 is refused in tab t2`);

// A closed tab's ids.
await call('tab_close', { tab: 't2' });
await call('tab_select', { tab: 't1' });
r = await call('click', { id: tabTwoPress });
check(r.isError && /tab closed since/.test(r.text), `${tabTwoPress} of the closed tab t2 is refused`);

// A browser closed and opened again: its ids go on with new letters, and the
// first browser's are refused.
await call('browser_close');
r = await call('browser_open', { profile: 'temp', headless: true, url: `${base}/one` });
const againLow = idOf(r.text, 'link', 'link 1');
check(againLow !== undefined && !againLow.startsWith('a'), `the next browser's first page does not start again at a (${againLow})`);
r = await call('click', { id: oneLow });
check(r.isError && /browser closed since/.test(r.text), `${oneLow} from the first browser is refused`);

await call('browser_close');
await client.close();
site.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
