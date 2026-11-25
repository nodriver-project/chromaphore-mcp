# Conventions

Every rule in sections 1 to 7 ends with a tag: `[checked: RULE]` when `tools/check_conventions.mjs` enforces it, or `[convention]` when reviewers and authors enforce it. The `RULEMARK` rule verifies that every rule bullet carries a valid tag and every checker rule is listed in section 8.

## 1. Layers and module boundaries

The TypeScript modules under `server/src/` sit in six layers (0 at the bottom, 5 at the top):

| Rank | Layer | Modules |
|---|---|---|
| 0 | foundation | `cdp.ts`, `paths.ts`, `listing.ts` |
| 1 | runtime | `launcher.ts`, `video.ts`, `browser.ts` |
| 2 | capabilities | `install.ts`, `canvas.ts` |
| 3 | editors | `editors/index.ts`, `editors/docs.ts` |
| 4 | actions | `actions.ts`, `browser_tools.ts` |
| 5 | entrypoint | `server.ts` |

- A module in `server/src/` imports only from lower ranks, except for the three documented same-layer pairs: `browser.ts` importing `video.ts`, `editors/index.ts` with `editors/docs.ts`, and `browser_tools.ts` importing `actions.ts`. [checked: LAYER]
- Every new file under `server/src/` is added to `RANKS` in `tools/check_conventions.mjs` and the table above in the same change. [checked: LAYER]
- `server/src/editors/` modules stay decoupled from `actions.ts`, `browser.ts`, and `server.ts`: they accept `EditorPage` from `editors/index.ts` and read only the canvas snapshot plus isolated-world DOM queries. [checked: LAYER]
- Runtime code under `server/src/` uses only Node built-ins (`node:*`), `@modelcontextprotocol/sdk`, and `zod`; avoid adding npm dependencies that bloat `plugin/dist/server.mjs` and `plugin/THIRD_PARTY_NOTICES.md`. [convention]

## 2. Tool contracts and replay gating

- Every tool registered via `server.registerTool(...)` in `server/src/server.ts` is listed in `README.md` and accounted for in `docs/PARITY.md`. [checked: TOOLS]
- Expected refusals (stale id, element covered, browser not open, missing video recording, invalid path) throw `ToolError` from `server/src/cdp.ts` so the MCP reply is plain, actionable text with `isError: true` and no stack trace. [convention]
- Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) reflect actual behaviour; never mark a tool that writes to disk or mutates page state as read-only. [convention]
- Replay-only options (`not_before`, `seed`, burst text check, `fetch` `save_to` overrides) stay behind `REPLAY_OPTIONS` in `server/src/server.ts`; when disabled, schemas, server instructions, and `plugin/skills/` must not mention them. [convention]
- Keep tool replies compact and scannable: return the settle line plus what changed, capping full listings and canvas dumps rather than flooding the model context. [convention]

## 3. Browser, CDP, and platform rules

- Drive page interactions through Chromaphore's custom CDP commands (`Input.moveTo`, `Input.dispatchKeystrokes`, `Input.performDrag`, etc.) rather than stock CDP input commands whose synthetic markers detectors check. [convention]
- Read-only page inspection runs in an isolated world (except `eval_js`, which runs in the page's main world by contract). [convention]
- Guard newer browser capabilities cleanly (feature-probing or checking `CdpError` for unknown commands/unsupported fields, plus `MIN_MAJOR` in `server/src/browser.ts`) so the server degrades gracefully or refuses with a clear message on older Chromaphore builds. [convention]
- Never pass `--disable-ipc-flooding-protection` in `server/src/browser.ts`: pages can detect it by counting `history.replaceState()` calls. [checked: SWITCHES]
- All tracked text files in the repository use LF (`\n`) line endings, matching `.gitattributes`, because Claude Code clones the plugin on Windows, macOS, and Linux. [checked: EOL]

## 4. Versioning and bundle integrity

- The plugin version lives in four places and all four MUST agree at all times: `VERSION` in `server/src/server.ts`, `server/package.json`, `server/package-lock.json` (root and `packages[""]`), and `plugin/.claude-plugin/plugin.json`. [checked: VERSION]
- `plugin/dist/server.mjs`, `plugin/dist/launcher.mjs`, `plugin/THIRD_PARTY_NOTICES.md`, `plugin/LICENSE`, and `plugin/NOTICE` are build outputs of `server/build.mjs` and are never hand-edited; commit rebuilt outputs with every `server/src/` change. [checked: BUNDLE]
- Every release bump follows `docs/RELEASE.md`: never reuse or silently overwrite a published version number. [convention]

## 5. Module headers, file sizes, and docs

- Every TypeScript source file under `server/src/` opens with a concise comment block stating what the module owns and any non-trivial contract. [checked: HEADER]
- Files over 1,500 lines are reported as an informational `LONG` note by the checker rather than failing; split a long file only along a real ownership boundary (as `canvas.ts` and `video.ts` were split out), never by mechanical line slicing. [convention]
- Every backticked repository path in `CLAUDE.md` and `docs/*.md` (other than generated `docs/MAP.md`) resolves to a real file or directory in the repository. [checked: DOCREF]
- `docs/MAP.md` is generated by `tools/map.mjs` and committed; never edit it by hand. [checked: MAP]
- Code comments describe what the code is and why, not chat sessions, review rounds, or internal plan stages. [convention]

## 6. CDP and NoDriver parity

- `docs/PARITY.md` holds the single parity table between Chromaphore's custom CDP commands/events and this MCP server, with each row marked `wired`, `excluded` (with a non-empty reason), or `planned`. [checked: PARITY]
- Every `wired` CDP command/event in `docs/PARITY.md` MUST be referenced in `server/src/`, and every `excluded` or `planned` entry MUST NOT be referenced in `server/src/` (moving a command from excluded/planned to implemented requires updating `docs/PARITY.md` in the same change). [checked: PARITY]
- Cross-repository parity against the Chromium tree is enforced by `C:\nodriver-bundle\tools\java_side_check.py`: every series-added custom CDP command/event in Chromium MUST appear in `docs/PARITY.md` (either `wired` or explicitly `excluded`/`planned`). [convention]

## 7. Tests

- Pure formatting, id-scheme, burst-planning, canvas-geometry, video-state, and convention-checker logic lives in browserless `server/test/*_unit.mjs` suites so CI verifies it without a Chromium binary. [convention]
- Browser end-to-end tests live in `server/test/*.mjs`, serve fixture pages from a local `node:http` server on `127.0.0.1`, use temporary profiles under `os.tmpdir()`, and clean up browser processes and temp directories on exit. [convention]
- Live tests against external sites (`docs_live.mjs`, `docs_canvas_live.mjs`) and Claude CLI sessions (`claude_session.mjs`, `claude_install_session.mjs`) are run manually before releases affecting those paths, never in CI. [convention]

## 8. Enforcement

`node tools/check_conventions.mjs` runs with Node >= 20, prints one line per finding as `<path>:<line>: <RULE> <message>`, and exits non-zero when any failing finding remains.

Rules in `RULES`:

- `LAYER`: an upward or unlisted same-layer local import in `server/src/**/*.ts`, or a source file missing from `RANKS`.
- `TOOLS`: a tool registered with `server.registerTool(...)` in `server/src/server.ts` missing from `README.md` or `docs/PARITY.md`.
- `SWITCHES`: `--disable-ipc-flooding-protection` present as a launch switch string in `server/src/browser.ts`.
- `EOL`: a CRLF (`\r\n`) line ending in any tracked text file under `server/src/`, `server/test/`, `tools/`, `docs/`, `plugin/` (excluding binaries), or root `.md`/`.json` files.
- `VERSION`: disagreement among `server/src/server.ts` (`VERSION`), `server/package.json`, `server/package-lock.json`, and `plugin/.claude-plugin/plugin.json`.
- `BUNDLE`: when `--check-bundle` is passed, `plugin/dist/server.mjs` or `plugin/dist/launcher.mjs` differs from an in-memory esbuild of `server/src/`.
- `HEADER`: a `server/src/**/*.ts` file that does not start with a leading comment explaining what it owns.
- `DOCREF`: a backticked repository path in `CLAUDE.md` or `docs/*.md` (excluding `docs/MAP.md`) that does not exist in the repository.
- `MAP`: `docs/MAP.md` differs from what `tools/map.mjs` generates.
- `PARITY`: `docs/PARITY.md` is missing or malformed, has duplicate CDP names, lists a `wired` name not present in `server/src/`, lists an `excluded` or `planned` name that IS present in `server/src/`, or has an `excluded` row with no reason.
- `RULEMARK`: a rule bullet in sections 1 to 7 of `docs/CONVENTIONS.md` lacks a `[checked: RULE]` or `[convention]` tag, names an unknown rule, or a rule in `RULES` is missing a tag or an entry in section 8.

Informational notes (never fail):
- `LONG`: any `server/src/**/*.ts` file exceeding 1,500 lines.

GitHub Actions (`.github/workflows/ci.yml`) runs `npx tsc --noEmit`, `node tools/check_conventions.mjs --check-bundle`, and all browserless unit suites on every push and pull request.
