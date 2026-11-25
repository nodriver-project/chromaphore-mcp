// Conventions, consistency, and parity checker for chromaphore-mcp.
// Prints `<path>:<line>: <RULE> <message>` per finding and exits 1 on failure.
// Usage:
//   node tools/check_conventions.mjs [--check-bundle] [--root <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RANKS, generateMap } from './map.mjs';

export const RULES = [
  'LAYER',
  'TOOLS',
  'SWITCHES',
  'EOL',
  'VERSION',
  'BUNDLE',
  'HEADER',
  'DOCREF',
  'MAP',
  'PARITY',
  'RULEMARK',
];

const LONG_FILE_LINES = 1500;

const ALLOWED_SAME_LAYER = new Set([
  'browser.ts->video.ts',
  'editors/index.ts->editors/docs.ts',
  'editors/docs.ts->editors/index.ts',
  'browser_tools.ts->actions.ts',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts', '.mts', '.js', '.mjs', '.md', '.json', '.yml', '.yaml', '.txt',
]);
const TEXT_BASENAMES = new Set(['.gitattributes', '.gitignore', 'LICENSE', 'NOTICE']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.scratch']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function relPosix(root, full) {
  return path.relative(root, full).replace(/\\/g, '/');
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

// Extracts string literals from JS/TS while skipping comments, returning { value, line }.
function extractStringLiterals(text) {
  const out = [];
  const token = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;
  let m;
  while ((m = token.exec(text))) {
    const raw = m[0];
    if (raw.startsWith('//') || raw.startsWith('/*')) continue;
    out.push({ value: raw.slice(1, -1), line: lineNumberAt(text, m.index) });
  }
  return out;
}

function checkLayersAndHeaders(root, findings, notes) {
  const srcDir = path.join(root, 'server', 'src');
  if (!fs.existsSync(srcDir)) {
    findings.push('server/src:1: LAYER missing server/src directory');
    return;
  }
  const files = walk(srcDir).filter((f) => f.endsWith('.ts'));
  for (const full of files) {
    const rel = relPosix(srcDir, full);
    const repoRel = `server/src/${rel}`;
    const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');

    // HEADER: leading comment before first code line
    const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? '';
    if (!firstNonEmpty.trim().startsWith('//') && !firstNonEmpty.trim().startsWith('/*')) {
      findings.push(`${repoRel}:1: HEADER missing leading comment describing what this module owns`);
    }

    // LONG note (informational only)
    const lineCount = lines.length - (text.endsWith('\n') ? 1 : 0);
    if (lineCount > LONG_FILE_LINES) {
      notes.push(`${repoRel}:1: LONG ${lineCount} lines (over ${LONG_FILE_LINES}; informational)`);
    }

    // LAYER
    const fromRank = RANKS[rel];
    if (fromRank === undefined) {
      findings.push(`${repoRel}:1: LAYER module is not listed in RANKS (tools/map.mjs and docs/CONVENTIONS.md)`);
      continue;
    }
    const impRe = /^\s*import\b[\s\S]*?\bfrom\s+['"](\.[^'"]+)['"]/gm;
    let m;
    while ((m = impRe.exec(text))) {
      const spec = m[1];
      const resolved = path.posix
        .normalize(path.posix.join(path.posix.dirname(rel), spec))
        .replace(/\.js$/, '.ts');
      const toRank = RANKS[resolved];
      const line = lineNumberAt(text, m.index);
      if (toRank === undefined) {
        findings.push(`${repoRel}:${line}: LAYER imports unranked local module \`${resolved}\``);
      } else if (toRank > fromRank) {
        findings.push(
          `${repoRel}:${line}: LAYER upward import from rank ${fromRank} to rank ${toRank} (\`${resolved}\`)`,
        );
      } else if (toRank === fromRank && resolved !== rel && !ALLOWED_SAME_LAYER.has(`${rel}->${resolved}`)) {
        findings.push(
          `${repoRel}:${line}: LAYER unlisted same-layer import \`${rel}\` -> \`${resolved}\``,
        );
      }
    }
  }
}

function checkVersion(root, findings) {
  const versions = [];
  const serverTs = path.join(root, 'server', 'src', 'server.ts');
  if (fs.existsSync(serverTs)) {
    const txt = fs.readFileSync(serverTs, 'utf8');
    const m = /const\s+VERSION\s*=\s*['"]([^'"]+)['"]/.exec(txt);
    if (!m) findings.push('server/src/server.ts:1: VERSION missing `const VERSION = ...`');
    else versions.push({ file: 'server/src/server.ts', line: lineNumberAt(txt, m.index), value: m[1] });
  }
  for (const [rel, extraLockCheck] of [
    ['server/package.json', false],
    ['server/package-lock.json', true],
    ['plugin/.claude-plugin/plugin.json', false],
  ]) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) {
      findings.push(`${rel}:1: VERSION missing file`);
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (typeof data.version !== 'string') {
        findings.push(`${rel}:1: VERSION missing top-level "version"`);
      } else {
        versions.push({ file: rel, line: 1, value: data.version });
      }
      if (extraLockCheck) {
        const rootPkgVer = data.packages?.['']?.version;
        if (rootPkgVer !== data.version) {
          findings.push(`${rel}:1: VERSION packages[""].version (${rootPkgVer}) disagrees with top-level (${data.version})`);
        }
      }
    } catch (e) {
      findings.push(`${rel}:1: VERSION invalid JSON (${e.message})`);
    }
  }
  const unique = new Set(versions.map((v) => v.value));
  if (unique.size > 1) {
    const detail = versions.map((v) => `${v.file}=${v.value}`).join(', ');
    findings.push(`plugin/.claude-plugin/plugin.json:1: VERSION mismatch across files: ${detail}`);
  }
}

function checkSwitches(root, findings) {
  const browserTs = path.join(root, 'server', 'src', 'browser.ts');
  if (!fs.existsSync(browserTs)) return;
  const txt = fs.readFileSync(browserTs, 'utf8');
  for (const lit of extractStringLiterals(txt)) {
    if (lit.value.includes('--disable-ipc-flooding-protection')) {
      findings.push(
        `server/src/browser.ts:${lit.line}: SWITCHES forbidden switch --disable-ipc-flooding-protection`,
      );
    }
  }
}

function checkEol(root, findings) {
  for (const full of walk(root)) {
    const rel = relPosix(root, full);
    const ext = path.extname(full).toLowerCase();
    const base = path.basename(full);
    if (!TEXT_EXTENSIONS.has(ext) && !TEXT_BASENAMES.has(base)) continue;
    const buf = fs.readFileSync(full);
    const idx = buf.indexOf(0x0d);
    if (idx !== -1 && buf[idx + 1] === 0x0a) {
      findings.push(`${rel}:1: EOL contains CRLF line endings (repository requires LF)`);
    }
  }
}

function checkTools(root, findings) {
  const serverTs = path.join(root, 'server', 'src', 'server.ts');
  if (!fs.existsSync(serverTs)) return;
  const txt = fs.readFileSync(serverTs, 'utf8');
  const re = /server\.registerTool\(\s*['"]([^'"]+)['"]/g;
  const tools = [];
  let m;
  while ((m = re.exec(txt))) {
    tools.push({ name: m[1], line: lineNumberAt(txt, m.index) });
  }
  for (const docRel of ['README.md', 'docs/PARITY.md']) {
    const full = path.join(root, docRel);
    if (!fs.existsSync(full)) {
      findings.push(`${docRel}:1: TOOLS missing file`);
      continue;
    }
    const docTxt = fs.readFileSync(full, 'utf8');
    for (const tool of tools) {
      if (!docTxt.includes(`\`${tool.name}\``)) {
        findings.push(
          `server/src/server.ts:${tool.line}: TOOLS registered tool \`${tool.name}\` is not documented in ${docRel}`,
        );
      }
    }
  }
}

export function parseParityTable(text) {
  const startMark = '<!-- parity-table:start -->';
  const endMark = '<!-- parity-table:end -->';
  const startIdx = text.indexOf(startMark);
  const endIdx = text.indexOf(endMark);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { error: 'missing <!-- parity-table:start --> / <!-- parity-table:end --> markers', rows: [] };
  }
  const block = text.slice(startIdx + startMark.length, endIdx);
  const baseLine = lineNumberAt(text, startIdx + startMark.length);
  const rows = [];
  const errors = [];
  const blockLines = block.split('\n');
  for (let i = 0; i < blockLines.length; i++) {
    const raw = blockLines[i].trim();
    if (!raw || !raw.startsWith('|')) continue;
    const cells = raw.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) {
      errors.push({ line: baseLine + i, message: `expected 5 columns, got ${cells.length}` });
      continue;
    }
    if (cells[0] === 'CDP name' || /^-+$/.test(cells[0])) continue;
    const nameMatch = /^`([A-Z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*)`$/.exec(cells[0]);
    const statusMatch = /^`(wired|excluded|planned)`$/.exec(cells[2]);
    if (!nameMatch) {
      errors.push({ line: baseLine + i, message: `invalid CDP name cell: ${cells[0]}` });
      continue;
    }
    if (!statusMatch) {
      errors.push({ line: baseLine + i, message: `invalid status cell: ${cells[2]} (expected wired, excluded, or planned)` });
      continue;
    }
    rows.push({
      line: baseLine + i,
      name: nameMatch[1],
      area: cells[1],
      status: statusMatch[1],
      target: cells[3],
      reason: cells[4],
    });
  }
  return { error: null, errors, rows };
}

function checkParity(root, findings) {
  const parityPath = path.join(root, 'docs', 'PARITY.md');
  if (!fs.existsSync(parityPath)) {
    findings.push('docs/PARITY.md:1: PARITY missing docs/PARITY.md');
    return;
  }
  const text = fs.readFileSync(parityPath, 'utf8').replace(/\r\n/g, '\n');
  const parsed = parseParityTable(text);
  if (parsed.error) {
    findings.push(`docs/PARITY.md:1: PARITY ${parsed.error}`);
    return;
  }
  for (const err of parsed.errors) {
    findings.push(`docs/PARITY.md:${err.line}: PARITY ${err.message}`);
  }
  if (!parsed.rows.length) {
    findings.push('docs/PARITY.md:1: PARITY parity table has no rows');
    return;
  }

  // Collect all Domain.name string literals used in server/src/
  const srcDir = path.join(root, 'server', 'src');
  const used = new Set();
  if (fs.existsSync(srcDir)) {
    const cdpRe = /^[A-Z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/;
    for (const full of walk(srcDir).filter((f) => f.endsWith('.ts'))) {
      const srcTxt = fs.readFileSync(full, 'utf8');
      for (const lit of extractStringLiterals(srcTxt)) {
        if (cdpRe.test(lit.value)) used.add(lit.value);
      }
    }
  }

  const seen = new Set();
  for (const row of parsed.rows) {
    if (seen.has(row.name)) {
      findings.push(`docs/PARITY.md:${row.line}: PARITY duplicate CDP name \`${row.name}\``);
      continue;
    }
    seen.add(row.name);
    if (row.status === 'wired' && !used.has(row.name)) {
      findings.push(
        `docs/PARITY.md:${row.line}: PARITY \`${row.name}\` is marked wired but does not appear in server/src/`,
      );
    }
    if ((row.status === 'excluded' || row.status === 'planned') && used.has(row.name)) {
      findings.push(
        `docs/PARITY.md:${row.line}: PARITY \`${row.name}\` is marked ${row.status} but is used in server/src/ (update status to wired)`,
      );
    }
    if (row.status === 'excluded' && (!row.reason || row.reason === '—' || row.reason === '-')) {
      findings.push(
        `docs/PARITY.md:${row.line}: PARITY excluded command \`${row.name}\` must state a reason`,
      );
    }
  }
}

function checkDocRefs(root, findings) {
  const docsToCheck = ['CLAUDE.md', 'docs/CONVENTIONS.md', 'docs/PARITY.md', 'docs/RELEASE.md'];
  const knownRoots = new Set(['server', 'plugin', 'tools', 'docs', '.github', '.claude-plugin']);
  const rootFiles = new Set(['README.md', 'CLAUDE.md', 'GEMINI.md', 'LICENSE', 'NOTICE', '.gitattributes', '.gitignore']);

  for (const rel of docsToCheck) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('```')) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const spanRe = /`([^`]+)`/g;
      let m;
      while ((m = spanRe.exec(line))) {
        const raw = m[1].trim();
        if (!raw || raw.includes(' ') || raw.includes('*') || raw.includes('<') || raw.includes('>') || raw.includes('${')) {
          continue;
        }
        if (/^[A-Za-z]:\\|^\/|^%|^[a-z]+:\/\//i.test(raw)) continue;
        const norm = raw.replace(/\\/g, '/').replace(/\/$/, '');
        const firstSeg = norm.split('/')[0];
        const looksLikeRepoPath =
          (norm.includes('/') && knownRoots.has(firstSeg)) || rootFiles.has(norm);
        if (!looksLikeRepoPath) continue;
        if (!fs.existsSync(path.join(root, norm))) {
          findings.push(`${rel}:${i + 1}: DOCREF \`${raw}\` does not exist in this repository`);
        }
      }
    }
  }
}

function checkMap(root, findings) {
  const mapPath = path.join(root, 'docs', 'MAP.md');
  const expected = generateMap(root);
  const actual = fs.existsSync(mapPath) ? fs.readFileSync(mapPath, 'utf8') : null;
  if (actual !== expected) {
    findings.push('docs/MAP.md:1: MAP docs/MAP.md is missing or stale; run `node tools/map.mjs`');
  }
}

function checkRuleMarks(root, findings) {
  const convPath = path.join(root, 'docs', 'CONVENTIONS.md');
  if (!fs.existsSync(convPath)) {
    findings.push('docs/CONVENTIONS.md:1: RULEMARK missing docs/CONVENTIONS.md');
    return;
  }
  const text = fs.readFileSync(convPath, 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  let section = 0;
  const taggedRules = new Set();
  const section8Rules = new Set();
  const validRules = new Set(RULES);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^##\s+(\d+)\./.exec(line);
    if (h) {
      section = Number(h[1]);
      continue;
    }
    if (section >= 1 && section <= 7 && line.startsWith('- ')) {
      const m = /\[(checked:\s*([A-Z]+)|convention)\]\s*$/.exec(line);
      if (!m) {
        findings.push(`docs/CONVENTIONS.md:${i + 1}: RULEMARK rule bullet must end with [checked: RULE] or [convention]`);
      } else if (m[2]) {
        if (!validRules.has(m[2])) {
          findings.push(`docs/CONVENTIONS.md:${i + 1}: RULEMARK unknown rule \`${m[2]}\``);
        } else {
          taggedRules.add(m[2]);
        }
      }
    } else if (section === 8) {
      const r = /^-\s+`([A-Z]+)`:/.exec(line);
      if (r && validRules.has(r[1])) section8Rules.add(r[1]);
    }
  }

  for (const rule of RULES) {
    if (rule === 'RULEMARK') {
      if (!section8Rules.has(rule)) {
        findings.push(`docs/CONVENTIONS.md:1: RULEMARK rule \`${rule}\` missing from section 8`);
      }
      continue;
    }
    if (!taggedRules.has(rule)) {
      findings.push(`docs/CONVENTIONS.md:1: RULEMARK rule \`${rule}\` is not named by any [checked: ${rule}] tag`);
    }
    if (!section8Rules.has(rule)) {
      findings.push(`docs/CONVENTIONS.md:1: RULEMARK rule \`${rule}\` is missing from section 8`);
    }
  }
}

async function checkBundle(root, findings) {
  const esbuildEntry = path.join(root, 'server', 'node_modules', 'esbuild', 'lib', 'main.js');
  if (!fs.existsSync(esbuildEntry)) {
    findings.push('server/node_modules:1: BUNDLE esbuild not installed; run `npm ci` in server/');
    return;
  }
  const { build } = await import(pathToFileURL(esbuildEntry).href);
  const common = {
    bundle: true,
    write: false,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    absWorkingDir: path.join(root, 'server'),
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    legalComments: 'none',
    logLevel: 'silent',
  };
  for (const [entry, outRel] of [
    ['src/server.ts', 'plugin/dist/server.mjs'],
    ['src/launcher.ts', 'plugin/dist/launcher.mjs'],
  ]) {
    const outPath = path.join(root, outRel);
    if (!fs.existsSync(outPath)) {
      findings.push(`${outRel}:1: BUNDLE missing built bundle; run \`cd server && node build.mjs\``);
      continue;
    }
    const res = await build({ ...common, entryPoints: [entry] });
    const built = Buffer.from(res.outputFiles[0].contents);
    const onDisk = fs.readFileSync(outPath);
    if (!built.equals(onDisk)) {
      findings.push(`${outRel}:1: BUNDLE out of date with server/src; run \`cd server && node build.mjs\``);
    }
  }
}

export async function runChecks({ root, checkBundleFlag = false } = {}) {
  const findings = [];
  const notes = [];
  checkLayersAndHeaders(root, findings, notes);
  checkVersion(root, findings);
  checkSwitches(root, findings);
  checkEol(root, findings);
  checkTools(root, findings);
  checkParity(root, findings);
  checkDocRefs(root, findings);
  checkMap(root, findings);
  checkRuleMarks(root, findings);
  if (checkBundleFlag) {
    await checkBundle(root, findings);
  }
  return { findings, notes };
}

async function main(argv) {
  let checkBundleFlag = false;
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check-bundle') checkBundleFlag = true;
    else if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[++i]);
    else {
      console.error('Usage: node tools/check_conventions.mjs [--check-bundle] [--root <dir>]');
      return 2;
    }
  }
  const { findings, notes } = await runChecks({ root, checkBundleFlag });
  for (const n of notes) console.log(n);
  for (const f of findings) console.log(f);
  if (findings.length) {
    console.log(`conventions check: FAILED (${findings.length} finding${findings.length === 1 ? '' : 's'})`);
    return 1;
  }
  console.log(`conventions check: passed (${RULES.length} rules${checkBundleFlag ? ', bundle verified' : ''})`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
