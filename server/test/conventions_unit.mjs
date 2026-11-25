// Unit tests for tools/check_conventions.mjs and tools/map.mjs without a browser.
// Usage: node test/conventions_unit.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from '../../tools/check_conventions.mjs';
import { generateMap } from '../../tools/map.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function makeMinimalFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chromaphore-conv-'));
  write(dir, 'CLAUDE.md', '# Fixture\nSee `docs/CONVENTIONS.md` and `server/src/server.ts`.\n');
  write(dir, 'README.md', '# Fixture\nTool: `ping`.\n');
  write(dir, 'server/src/cdp.ts', '// Transport.\nexport const x = 1;\n');
  write(dir, 'server/src/browser.ts', "// Browser.\nimport { x } from './cdp.js';\nexport const b = x;\n");
  write(
    dir,
    'server/src/server.ts',
    "// Entry.\nimport { b } from './browser.js';\nconst VERSION = '1.2.3';\nconst c = 'Browser.agentFetch';\nserver.registerTool('ping', {}, () => b + VERSION + c);\n",
  );
  write(dir, 'server/package.json', JSON.stringify({ name: 'test', version: '1.2.3' }, null, 2) + '\n');
  write(
    dir,
    'server/package-lock.json',
    JSON.stringify({ name: 'test', version: '1.2.3', packages: { '': { version: '1.2.3' } } }, null, 2) + '\n',
  );
  write(
    dir,
    'plugin/.claude-plugin/plugin.json',
    JSON.stringify({ name: 'test', version: '1.2.3' }, null, 2) + '\n',
  );
  write(
    dir,
    'docs/PARITY.md',
    [
      '# Parity',
      'Tool: `ping`.',
      '<!-- parity-table:start -->',
      '| CDP name | Area | Status | MCP tool / module | Notes / exclusion reason |',
      '|---|---|---|---|---|',
      '| `Browser.agentFetch` | fetch | `wired` | `ping` (`server.ts`) | Used |',
      '| `Browser.recordingMask` | fetch | `excluded` | — | Secret redaction omitted |',
      '<!-- parity-table:end -->',
      '',
    ].join('\n'),
  );
  write(
    dir,
    'docs/CONVENTIONS.md',
    [
      '# Conventions',
      '## 1. Layers',
      '- Layers. [checked: LAYER]',
      '## 2. Tools',
      '- Tools. [checked: TOOLS]',
      '## 3. Browser',
      '- Switches. [checked: SWITCHES]',
      '- EOL. [checked: EOL]',
      '## 4. Versioning',
      '- Version. [checked: VERSION]',
      '- Bundle. [checked: BUNDLE]',
      '## 5. Headers and docs',
      '- Header. [checked: HEADER]',
      '- Docref. [checked: DOCREF]',
      '- Map. [checked: MAP]',
      '## 6. Parity',
      '- Parity. [checked: PARITY]',
      '## 7. Tests',
      '- Tests. [convention]',
      '## 8. Enforcement',
      '- `LAYER`: layer',
      '- `TOOLS`: tools',
      '- `SWITCHES`: switches',
      '- `EOL`: eol',
      '- `VERSION`: version',
      '- `BUNDLE`: bundle',
      '- `HEADER`: header',
      '- `DOCREF`: docref',
      '- `MAP`: map',
      '- `PARITY`: parity',
      '- `RULEMARK`: rulemark',
      '',
    ].join('\n'),
  );
  write(dir, 'docs/RELEASE.md', '# Release\nSee `server/package.json`.\n');
  write(dir, 'docs/MAP.md', generateMap(dir));
  return dir;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('real repository passes all rules including bundle check', async () => {
  const { findings } = await runChecks({ root: REPO_ROOT, checkBundleFlag: true });
  assert.deepEqual(findings, []);
});

test('clean synthetic fixture passes', async () => {
  const dir = makeMinimalFixture();
  try {
    const { findings } = await runChecks({ root: dir });
    assert.deepEqual(findings, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LAYER catches upward imports and unranked files', async () => {
  const dir = makeMinimalFixture();
  try {
    write(dir, 'server/src/cdp.ts', "// Transport.\nimport { b } from './browser.js';\nexport const x = b;\n");
    write(dir, 'server/src/mystery.ts', '// Mystery.\nexport const m = 1;\n');
    write(dir, 'docs/MAP.md', generateMap(dir));
    const { findings } = await runChecks({ root: dir });
    assert.ok(findings.some((f) => f.includes('LAYER') && f.includes('upward import')), findings.join('\n'));
    assert.ok(findings.some((f) => f.includes('LAYER') && f.includes('mystery.ts')), findings.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('VERSION catches disagreement across version files', async () => {
  const dir = makeMinimalFixture();
  try {
    write(dir, 'plugin/.claude-plugin/plugin.json', JSON.stringify({ name: 'test', version: '9.9.9' }, null, 2) + '\n');
    const { findings } = await runChecks({ root: dir });
    assert.ok(findings.some((f) => f.includes('VERSION mismatch')), findings.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SWITCHES catches --disable-ipc-flooding-protection', async () => {
  const dir = makeMinimalFixture();
  try {
    write(dir, 'server/src/browser.ts', "// Browser.\nexport const s = '--disable-ipc-flooding-protection';\n");
    write(dir, 'docs/MAP.md', generateMap(dir));
    const { findings } = await runChecks({ root: dir });
    assert.ok(findings.some((f) => f.includes('SWITCHES')), findings.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EOL catches CRLF line endings', async () => {
  const dir = makeMinimalFixture();
  try {
    fs.writeFileSync(path.join(dir, 'server/src/cdp.ts'), '// Transport.\r\nexport const x = 1;\r\n', 'utf8');
    const { findings } = await runChecks({ root: dir });
    assert.ok(findings.some((f) => f.includes('EOL') && f.includes('cdp.ts')), findings.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HEADER catches source files without leading comment', async () => {
  const dir = makeMinimalFixture();
  try {
    write(dir, 'server/src/cdp.ts', 'export const x = 1;\n');
    write(dir, 'docs/MAP.md', generateMap(dir));
    const { findings } = await runChecks({ root: dir });
    assert.ok(findings.some((f) => f.includes('HEADER') && f.includes('cdp.ts')), findings.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TOOLS catches undocumented registered tool', async () => {
  const dir = makeMinimalFixture();
  try {
    write(
      dir,
      'server/src/server.ts',
      "// Entry.\nimport { b } from './browser.js';\nconst VERSION = '1.2.3';\nconst c = 'Browser.agentFetch';\nserver.registerTool('ping', {}, () => b + VERSION + c);\nserver.registerTool('secret_extra', {}, () => null);\n",
    );
    write(dir, 'docs/MAP.md', generateMap(dir));
    const { findings } = await runChecks({ root: dir });
    assert.ok(findings.some((f) => f.includes('TOOLS') && f.includes('secret_extra')), findings.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PARITY catches wired-missing, excluded-used, and missing reason', async () => {
  const dir = makeMinimalFixture();
  try {
    write(
      dir,
      'docs/PARITY.md',
      [
        '# Parity',
        'Tool: `ping`.',
        '<!-- parity-table:start -->',
        '| CDP name | Area | Status | MCP tool / module | Notes / exclusion reason |',
        '|---|---|---|---|---|',
        '| `Browser.agentFetch` | fetch | `excluded` | — | — |',
        '| `Browser.getFingerprint` | id | `wired` | `fp` | Not actually in code |',
        '<!-- parity-table:end -->',
        '',
      ].join('\n'),
    );
    const { findings } = await runChecks({ root: dir });
    assert.ok(findings.some((f) => f.includes('PARITY') && f.includes('Browser.agentFetch') && f.includes('used in server/src')), findings.join('\n'));
    assert.ok(findings.some((f) => f.includes('PARITY') && f.includes('must state a reason')), findings.join('\n'));
    assert.ok(findings.some((f) => f.includes('PARITY') && f.includes('Browser.getFingerprint') && f.includes('does not appear')), findings.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DOCREF and MAP catch broken paths and stale maps', async () => {
  const dir = makeMinimalFixture();
  try {
    write(dir, 'CLAUDE.md', '# Fixture\nMissing: `server/src/does_not_exist.ts`.\n');
    write(dir, 'docs/MAP.md', '# Stale\n');
    const { findings } = await runChecks({ root: dir });
    assert.ok(findings.some((f) => f.includes('DOCREF') && f.includes('does_not_exist.ts')), findings.join('\n'));
    assert.ok(findings.some((f) => f.includes('MAP')), findings.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RULEMARK catches untagged rules and unknown rule names', async () => {
  const dir = makeMinimalFixture();
  try {
    write(
      dir,
      'docs/CONVENTIONS.md',
      [
        '# Conventions',
        '## 1. Layers',
        '- Missing tag here.',
        '- Bad rule. [checked: NOPE]',
        '## 8. Enforcement',
        '- `RULEMARK`: rulemark',
        '',
      ].join('\n'),
    );
    const { findings } = await runChecks({ root: dir });
    assert.ok(findings.some((f) => f.includes('RULEMARK') && f.includes('must end with')), findings.join('\n'));
    assert.ok(findings.some((f) => f.includes('RULEMARK') && f.includes('unknown rule `NOPE`')), findings.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

let passed = 0;
for (const { name, fn } of tests) {
  await fn();
  console.log(`PASS ${name}`);
  passed++;
}
console.log(`conventions_unit: ${passed}/${tests.length} passed`);
