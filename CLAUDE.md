# chromaphore-mcp

Claude Code plugin and bundled MCP server (`plugin/dist/server.mjs`) that drives the Chromaphore browser over `--remote-debugging-pipe` using Chromaphore's custom CDP commands.

- **Design rationale:** `docs/DESIGN.md`
- **Code and doc conventions:** `docs/CONVENTIONS.md`
- **Module and test map (generated):** `docs/MAP.md`
- **CDP and NoDriver tool parity contract:** `docs/PARITY.md`
- **CI and release checklist:** `docs/RELEASE.md`
- **Sibling repositories:** the browser patch series and cycle handbook live in `C:\nodriver-bundle\` (`C:\nodriver-bundle\docs\rules.md`, `C:\nodriver-bundle\docs\cycle\java-side.md`); the Java launcher lives in `C:\Users\leofo\IdeaProjects\NoDriver4j\`.

## Architecture and module layers

Source lives in `server/src/` (TypeScript, ESM, Node >= 20) and bundles with esbuild (`server/build.mjs`) into `plugin/dist/server.mjs` and `plugin/dist/launcher.mjs` so installed users need no `npm install`.

Imports flow strictly downward (`LAYER` rule in `tools/check_conventions.mjs`):

```
0  foundation    cdp.ts, paths.ts, listing.ts
1  runtime       launcher.ts, video.ts, browser.ts
2  capabilities  install.ts, canvas.ts
3  editors       editors/index.ts, editors/docs.ts
4  actions       actions.ts, browser_tools.ts
5  entrypoint    server.ts
```

Same-layer imports are allowed only within `editors/` (`editors/index.ts` and `editors/docs.ts` share the `Editor` interface), from `browser.ts` to `video.ts` (one video recorder per browser instance), and from `browser_tools.ts` to `actions.ts` (shared helper reuse).

## Where new code goes

- **Tab-level interaction or custom CDP command:** `server/src/actions.ts`, unless the feature owns non-trivial state, parsing, or formatting of its own (like `server/src/canvas.ts` or `server/src/video.ts`), in which case give it a Layer 1 or Layer 2 module and call it from `actions.ts` or `server.ts`.
- **Browser-target CDP command (no tab `sessionId`):** `server/src/browser_tools.ts` (or a dedicated Layer 1 module like `server/src/video.ts` when it tracks lifecycle state across actions).
- **MCP tool registration:** `server/src/server.ts` (`server.registerTool(...)`) with Zod schema, accurate `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), and `ToolError` handling. Mirror every tool change in `README.md`, `docs/PARITY.md`, and `plugin/skills/browser/SKILL.md`.
- **Editor-specific canvas reader (caret, selection):** a new module under `server/src/editors/`, registered in `server/src/editors/index.ts`. Identify the editor by DOM/canvas signature in an isolated world, never by URL.
- **Launch switch or `--disable-features` entry:** `BASE_SWITCHES` or `Browser.open` in `server/src/browser.ts`. Mirror `NoDriver4j`'s `LaunchArguments` unless documented otherwise in `docs/DESIGN.md`; never pass `--disable-ipc-flooding-protection`. Verify with `C:\nodriver-bundle\tools\java_side_check.py`.
- **Replay-only option (`not_before`, `seed`, burst text check):** gated behind `REPLAY_OPTIONS` in `server/src/server.ts`. When the setting is off, nothing in tool schemas, server instructions, or `plugin/skills/` may mention it (`server/test/replay_options.mjs`).
- **On-disk profiles, releases, or temp state:** `server/src/paths.ts`, under `%LOCALAPPDATA%\Chromaphore` (or platform equivalent), never inside Claude Code's plugin data folder.
- **Pure logic tests (no browser):** `server/test/*_unit.mjs` — runs in CI on every push and PR.
- **Browser end-to-end tests:** `server/test/*.mjs` against a local HTTP server first, using `os.tmpdir()` profiles and never mutating the user's real browser profiles.

## CDP and NoDriver parity contract

A curated subset of Chromaphore's custom CDP commands and NoDriver's agent tool concepts makes up this MCP server. To prevent the MCP from silently falling behind browser changes:

1. Every custom CDP command or event added by the Chromaphore series MUST have a row in `docs/PARITY.md` marked `wired`, `excluded` (with rationale), or `planned`.
2. `C:\nodriver-bundle\tools\java_side_check.py` verifies BOTH directions against the Chromium tree: every switch, feature, and CDP name used in `server/src/` exists in Chromium, AND every series-added custom CDP command/event in Chromium is accounted for in `docs/PARITY.md` (with `wired` matching actual `server/src/` usage).
3. Secret redaction (`type_secret`, `Browser.recordingMask`, `Page.agentMarkSecretField`, `Page.agentFinishCapture`) and NoDriver desktop GUI plumbing (`Page.*FrameStream`) are intentionally out of scope for MCP and stay marked `excluded` in `docs/PARITY.md`.

## Tooling (from the repository root)

- **Typecheck:** `cd server && npx tsc --noEmit`
- **Build bundle and notices:** `cd server && node build.mjs` (updates `plugin/dist/server.mjs`, `plugin/dist/launcher.mjs`, `plugin/THIRD_PARTY_NOTICES.md`, `plugin/LICENSE`, `plugin/NOTICE`)
- **Regenerate module map:** `node tools/map.mjs` (`--check` fails if `docs/MAP.md` is stale)
- **Conventions and consistency check:** `node tools/check_conventions.mjs` (add `--check-bundle` to verify `plugin/dist/*.mjs` matches `server/src/` byte-for-byte without writing)
- **Unit tests (no browser):** run from `server/`:
  - `node test/ids_unit.mjs`
  - `node test/bursts_unit.mjs`
  - `node test/canvas_unit.mjs`
  - `node test/video_unit.mjs`
  - `node test/conventions_unit.mjs`
- **Live tests (requires Chromaphore `chrome.exe`):** see `docs/RELEASE.md`, section "Live test matrix".
- **Cross-repo CDP parity check (against Chromium tree):**
  `py -3 -I C:\nodriver-bundle\tools\java_side_check.py --tip HEAD`

## Done checklist for any change

1. Typecheck (`npx tsc --noEmit`) and bundle build (`node build.mjs`) pass with zero errors.
2. `node tools/map.mjs --check` and `node tools/check_conventions.mjs --check-bundle` pass with zero findings.
3. All browserless unit tests pass, and every affected live test passes against a real Chromaphore binary.
4. Any added, changed, or removed MCP tool or custom CDP command is reflected in `docs/PARITY.md`, `README.md`, `docs/DESIGN.md`, and `plugin/skills/browser/SKILL.md`.
5. If a release version changed, all four version files match (`VERSION` rule) and `docs/RELEASE.md` has been followed.
6. Every touched text file uses LF line endings (`.gitattributes`, `EOL` rule).
7. Report files added, updated, and removed, what was run to verify, and what the change could break.

## Working with the owner

- Ask concise product questions only when a missing decision would materially change behaviour; make routine engineering calls yourself.
- Do not commit or push without the owner's explicit approval.
- Keep user-facing wording plain and concise: describe what changed, how it was verified, and any risks or caveats.
