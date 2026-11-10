// The checks an id gets before it is acted on, as NoDriver makes them
// (bridge/session/IdCheck.java): an element that no longer reads as it was
// shown (refused once, then acted on), one behind a layer open on top, one no
// longer listed, one off screen the agent was never shown, and any id while
// the page loads a new document. The page changes are made with eval_js, so
// no listing has told the agent of them.
// Usage: node test/id_checks.mjs [server.mjs]
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = process.argv[2] ?? path.resolve(here, '../../plugin/dist/server.mjs');

const PAGE = `<!doctype html><title>checks</title>
<p id="out">nothing</p>
<button id="save" onclick="out.textContent='pressed ' + this.textContent">Save</button>
<button id="hide" onclick="out.textContent='hide pressed'">Hide me</button>
<a href="/slow">Slow page</a>
<input id="q" aria-label="Search" placeholder="Type here" onclick="out.textContent='search pressed'">
<button onclick="document.getElementById('q').placeholder='Something else'">Place</button>
<button id="remove">Remove me</button>
<dialog id="dlg"><p>A modal</p><button onclick="dlg.close()">Close</button></dialog>
<div style="height:3000px"></div>
${Array.from({ length: 5 }, () => `<img width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onclick="out.textContent='image pressed'">`).join('\n')}`;
const site = http.createServer((req, res) => {
  if (req.url === '/slow') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>slow</title><p>landed</p>');
    }, 8000);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const env = { ...process.env };
delete env.CHROMAPHORE_BROWSER;
const client = new Client({ name: 'id-checks-test', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'inherit' }));

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`  ${name} ${JSON.stringify(args)}: ${r.isError ? 'ERROR ' : ''}${text.split('\n')[0]}`);
  return { text, isError: !!r.isError };
}
const idOf = (listing, role, name) => new RegExp(`^([a-z]+\\d+) ${role} "${name}"`, 'm').exec(listing)?.[1];
const js = (expression) => call('eval_js', { expression });

let r = await call('browser_open', { profile: 'temp', headless: true, url: `${base}/` });
const printed = [...r.text.matchAll(/^([a-z]+)(\d+) /gm)].map((m) => Number(m[2]));
const save = idOf(r.text, 'button', 'Save');
const hide = idOf(r.text, 'button', 'Hide me');
const slow = idOf(r.text, 'link', 'Slow page');
const search = idOf(r.text, 'textbox', 'Search');
const place = idOf(r.text, 'button', 'Place');
const remove = idOf(r.text, 'button', 'Remove me');

// What changed without a line in the action's reply (a field's placeholder,
// its name the same) is kept as shown by the capture: no false refusal.
r = await call('click', { id: place });
check(!/~ .*Search/.test(r.text), "the placeholder's change prints no line");
r = await call('click', { id: search });
check(!r.isError && (await js("document.getElementById('out').textContent")).text.includes('search pressed'), 'a field whose placeholder changed quietly is still clicked');

// Reads changed since seen: refused once with what it reads now, then acted on.
await js("document.getElementById('save').textContent = 'Delete account'");
r = await call('click', { id: save });
check(r.isError && /was button "Save" when you saw it; it now reads "Delete account"/.test(r.text), 'a renamed button is refused with what it reads now');
r = await call('click', { id: save });
check(!r.isError && (await js("document.getElementById('out').textContent")).text.includes('pressed Delete account'), 'the retry acts on it');

// Behind a layer a listing since has shown open on top.
await js("document.getElementById('dlg').showModal()");
await call('observe');
r = await call('click', { id: hide });
check(r.isError && /is behind dialog .* now, so nothing can reach it/.test(r.text), 'an element behind a dialog opened since is refused, naming it');
await js("document.getElementById('dlg').close()");
r = await call('click', { id: hide });
check(r.isError && /was behind dialog .* and that has closed since/.test(r.text), 'with the dialog closed since, the id asks for a new look');
await call('observe');

// Gone from the page.
await js("document.getElementById('remove').remove()");
r = await call('click', { id: remove });
check(r.isError && /no longer on the page/.test(r.text), 'a removed element is refused as gone');

// No longer listed: hidden, and a listing since has left it out.
await js("document.getElementById('hide').style.display = 'none'");
await call('observe');
r = await call('click', { id: hide });
check(r.isError && /no longer listed/.test(r.text), 'a hidden element a listing has since left out is refused as no longer listed');

// Off screen and never shown: the unnamed images below the fold, which a
// summary listing leaves out, are labelled after what it printed.
const unseen = `${save.replace(/\d+$/, '')}${Math.max(...printed) + 1}`;
r = await call('click', { id: unseen });
check(r.isError && /not an id you were shown/.test(r.text), `${unseen}, minted but never printed, is refused`);

// A page loading: the click on the slow link answers before the load lands.
r = await call('click', { id: slow });
r = await call('click', { id: save });
check(r.isError && /loading a new document/.test(r.text), 'an id while a new document loads is refused');

await call('browser_close');
await client.close();
site.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
