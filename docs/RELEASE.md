# CI and Release Process

## Version numbers

This repository uses semantic versioning (`0.MINOR.PATCH` while pre-1.0):

- **MINOR** (`0.X.0`): new MCP tools, new custom CDP capability support, or notable tool-schema / behaviour changes.
- **PATCH** (`0.X.Y`): bug fixes, listing/formatting refinements, or compatibility updates with no new tool families.

The version is stored in **four** files. `tools/check_conventions.mjs` (`VERSION` rule) fails if they disagree:

| File | Field |
|---|---|
| `server/src/server.ts` | `const VERSION = 'X.Y.Z';` |
| `server/package.json` | `"version": "X.Y.Z"` |
| `server/package-lock.json` | root `"version"` and `packages[""].version` |
| `plugin/.claude-plugin/plugin.json` | `"version": "X.Y.Z"` |

Claude Code discovers updates from `plugin/.claude-plugin/plugin.json` on the `main` branch of `nodriver-project/chromaphore-mcp`.

## Continuous Integration (`.github/workflows/ci.yml`)

Every push and pull request runs on Node 22:

1. `npm ci` in `server/`
2. `npx tsc --noEmit` in `server/`
3. `node tools/check_conventions.mjs --check-bundle` (verifies layers, version agreement, LF line endings, headers, tool docs, `docs/PARITY.md` consistency, `docs/MAP.md` freshness, doc references, rule marks, and that `plugin/dist/server.mjs` and `plugin/dist/launcher.mjs` match `server/src/` byte-for-byte)
4. All browserless unit suites:
   - `node server/test/ids_unit.mjs`
   - `node server/test/bursts_unit.mjs`
   - `node server/test/canvas_unit.mjs`
   - `node server/test/video_unit.mjs`
   - `node server/test/conventions_unit.mjs`

Browser end-to-end tests require a Chromaphore binary and run locally before every release.

## Pre-release checklist

Run through these steps in order before cutting a release on `main`:

### 1. CDP and NoDriver parity audit

1. Against the target Chromaphore tree (`C:\chromaphore-NNN\build\src`), run:
   ```
   py -3 -I C:\nodriver-bundle\tools\java_side_check.py --tip HEAD
   ```
   Confirm zero findings in both directions:
   - Every launch switch, `--disable-features` entry, and CDP name in `server/src/` exists in Chromium.
   - Every custom CDP command and event added by the Chromaphore series is either `wired` in `server/src/` or explicitly `excluded` / `planned` in `docs/PARITY.md`.
2. Grep `server/src/` for any CDP command **parameters** or **answer fields** renamed or removed in the target Chromium cycle (`java_side_check.py` checks command/event names, not parameter or reply field names).
3. Review any `planned` rows in `docs/PARITY.md` and confirm with the owner whether they belong in this release.

### 2. Build and static verification

From `server/`:
```
npx tsc --noEmit
node build.mjs
```

From the repository root:
```
node tools/map.mjs --check
node tools/check_conventions.mjs --check-bundle
```

If `docs/MAP.md` changed (new or renamed source/test files or updated module headers), regenerate it with `node tools/map.mjs` and review the diff.

### 3. Unit test matrix (no browser)

From `server/`:
```
node test/ids_unit.mjs
node test/bursts_unit.mjs
node test/canvas_unit.mjs
node test/video_unit.mjs
node test/conventions_unit.mjs
```

### 4. Live test matrix (with Chromaphore `chrome.exe`)

Set `CHROMAPHORE_TEST_BROWSER` (or pass `<chrome.exe>` where accepted) to the target Chromaphore build and run every local-server suite affected by the release — and the full local matrix for every MINOR release:

| Suite (from `server/`) | What it verifies |
|---|---|
| `node test/smoke.mjs <chrome.exe>` | Core tools over stdio MCP on a local site |
| `node test/phase2.mjs <chrome.exe>` | Native controls (`select`, `fill_date`, `pick_color`, `upload`), slider/drag, `paste`, `fetch`, traffic recording, `fingerprint` |
| `node test/browser_input.mjs <chrome.exe>` | Human-timed mouse/keyboard input paths |
| `node test/points_and_bursts.mjs <chrome.exe>` | Coordinate clicks/drags, scripted bursts, `expect_focus` (replay options off) |
| `node test/focus_cancel_fetch.mjs <chrome.exe>` | Shadow-DOM/iframe focus checks, cancelled bursts, `fetch` `save_to`, refused drags |
| `node test/id_checks.mjs <chrome.exe>` | Stale/covered/off-screen id refusals |
| `node test/second_document.mjs` | Multi-document page-letter id scoping (`a12`, `b12`, ...) |
| `node test/view_scale.mjs <chrome.exe>` | Scaled screenshot coordinates and `snapshot_id` validation |
| `node test/canvas_text.mjs` | `Page.agentCanvasText`, canvas listing, text aiming, `untrackedBitmap` |
| `node test/docs_editor.mjs` | Google Docs editor module (`editors/docs.ts`) on a local fixture |
| `node test/video_recording.mjs` | `video_start`, `video_pause`, `video_resume`, `video_mark`, `video_stop`, idle-cut, sidecar |
| `node test/replay_options.mjs` | Replay-option gating on and off (schema/instructions/skills invisibility) |
| `node test/temp_profile.mjs <chrome.exe>` | Temporary profile creation, cleanup on close/exit, and stale sweep |
| `node test/migrate.mjs` | Migration from pre-0.2.0 `%LOCALAPPDATA%\Chromeleon` layout |

Run these external / CLI suites manually when their code paths changed:

- `node test/docs_canvas_live.mjs` and `node test/docs_live.mjs` — live Google Docs end-to-end checks (when touching `canvas.ts`, `editors/docs.ts`, or input bursts).
- `node test/install.mjs` — `browser_install` download, SHA-256 check, unpack, and launch (when touching `install.ts` or browser release naming).
- `node test/claude_session.mjs` (`--temp`) and `node test/claude_install_session.mjs` — full Claude Code CLI plugin lifecycle (when touching `launcher.ts`, `plugin/.mcp.json`, or `plugin/skills/`).

### 5. Documentation and user-facing surface sync

Verify every affected doc matches the implementation:

- `README.md` (tool table, behaviour summaries, repo layout)
- `docs/DESIGN.md` (architectural rationale for new capabilities)
- `docs/PARITY.md` (all custom CDP commands and NoDriver tool concepts)
- `docs/MAP.md` (regenerated via `node tools/map.mjs`)
- `plugin/skills/browser/SKILL.md` and `plugin/skills/install/SKILL.md`
- `plugin/THIRD_PARTY_NOTICES.md` (regenerated automatically by `server/build.mjs`)

### 6. Version bump and final build

1. Bump all four version locations to the release version.
2. Run `cd server && node build.mjs` so `plugin/dist/server.mjs` embeds the new `VERSION`.
3. Re-run `node tools/check_conventions.mjs --check-bundle` and all unit tests.
4. For MINOR releases or large changes, consider a read-only second-perspective review before pushing.

### 7. Publish and verify

1. With the owner's approval, commit on `main` and push to `origin/main` (`nodriver-project/chromaphore-mcp`).
2. Confirm GitHub Actions CI passes on `main`.
3. Re-run `py -3 -I C:\nodriver-bundle\tools\java_side_check.py --tip HEAD` (which reads `chromaphore-mcp`'s committed `main`) and confirm `java-side check: passed`.

## Rolling back a release

Never force-push or rewrite `main`. Instead:

1. Revert the breaking commit(s) on `main`.
2. Bump the patch version in all four version files (e.g., `0.5.0` -> `0.5.1`).
3. Rebuild the bundle (`cd server && node build.mjs`) and run `node tools/check_conventions.mjs --check-bundle` plus unit tests.
4. Commit and push to `origin/main` so Claude Code picks up the higher patch version automatically.
