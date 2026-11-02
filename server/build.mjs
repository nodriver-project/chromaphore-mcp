// Bundles the server and the launcher into plugin/dist, one file each, so the
// installed plugin needs Node and nothing from npm, and writes the licence
// notices of every npm package the bundle includes to
// plugin/THIRD_PARTY_NOTICES.md (their licences require them in every copy).
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Bundled CommonJS dependencies may call require().
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
};

const server = await build({
  ...common,
  entryPoints: ['src/server.ts'],
  outfile: '../plugin/dist/server.mjs',
  metafile: true,
});
await build({ ...common, entryPoints: ['src/launcher.ts'], outfile: '../plugin/dist/launcher.mjs' });

// The packages whose files went into the bundle.
const packages = new Set();
for (const input of Object.keys(server.metafile.outputs['../plugin/dist/server.mjs'].inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m) packages.add(m[1]);
}
const notices = [
  '# Third-party notices',
  '',
  '`dist/server.mjs` includes the following npm packages, each under its own licence, reproduced here as those licences require.',
  '',
];
for (const name of [...packages].sort()) {
  const dir = path.join('node_modules', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  notices.push(`## ${name} ${pkg.version} (${pkg.license ?? 'see below'})`, '');
  notices.push(
    file ? '```\n' + fs.readFileSync(path.join(dir, file), 'utf8').trim() + '\n```' : '(no licence file in the package)',
    '',
  );
}
fs.writeFileSync('../plugin/THIRD_PARTY_NOTICES.md', notices.join('\n'));
// The plugin folder is what users get, so the licence and notice go in it too.
fs.copyFileSync('../LICENSE', '../plugin/LICENSE');
fs.copyFileSync('../NOTICE', '../plugin/NOTICE');
console.log(`built plugin/dist/server.mjs and plugin/dist/launcher.mjs; notices for ${packages.size} packages:`);
console.log([...packages].sort().join(', '));
