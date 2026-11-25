# CDP and NoDriver Parity Contract

This document is the single source of truth tracking how Chromaphore's custom CDP commands and NoDriver's agent tool concepts map into `chromaphore-mcp`.

Both `tools/check_conventions.mjs` (in this repository) and `C:\nodriver-bundle\tools\java_side_check.py` (in the browser bundle repository) parse the **Custom CDP commands and events** table below.

## Scope rule: what belongs in `chromaphore-mcp`

A curated subset of Chromaphore's custom CDP capabilities and NoDriver's agent tool concepts belongs in this MCP server:

- **In scope:** general browser lifecycle and install, tab management, observation and DOM/canvas listings, human-timed pointer/keyboard/form/drag/clipboard input, page reads (`fetch`), HAR traffic recording, agent video recording, and fingerprint inspection.
- **Out of scope:** secret vaults and secret redaction (`type_secret`, `Browser.recordingMask`, `Page.agentMarkSecretField`, `Page.agentFinishCapture`), NoDriver desktop GUI plumbing (`Page.*FrameStream`, pause overlay), checkout profiles, proxy rotation, IMAP/SMS providers, checkpoints, and multi-agent bridge leases.
- **Rule for new CDP work:** whenever a Chromium cycle or feature adds a custom CDP command or event, it MUST be added to the table below as `wired` (implemented in `server/src/`), `excluded` (with an explicit rationale), or `planned` (accepted for a follow-up MCP change). Unaccounted custom CDP commands fail `C:\nodriver-bundle\tools\java_side_check.py`.

## Custom CDP commands and events

Statuses:
- `wired`: called or listened to in `server/src/` (machine-verified).
- `excluded`: intentionally omitted from `chromaphore-mcp`, with rationale (machine-verified not in `server/src/`).
- `planned`: accepted for `chromaphore-mcp`, not yet implemented (machine-verified not in `server/src/`; printed in `java_side_check.py` output until wired).

<!-- parity-table:start -->
| CDP name | Area | Status | MCP tool / module | Notes / exclusion reason |
|---|---|---|---|---|
| `Browser.agentFetch` | fetch-and-recording | `wired` | `fetch` (`browser_tools.ts`) | Fetches a URL through the browser's network stack and cookies without a tab |
| `Browser.agentFetchCancel` | fetch-and-recording | `excluded` | — | MCP `fetch` awaits one synchronous call with no concurrent cancel handle; wire if abort support is added |
| `Browser.getFingerprint` | identity-and-switches | `wired` | `fingerprint` (`browser.ts`, `browser_tools.ts`) | Reports the resolved browser fingerprint and active font bundle |
| `Browser.markVideoRecording` | video-recording | `wired` | `video_mark` (`video.ts`) | Writes a timestamped event marker to the active video sidecar |
| `Browser.pauseVideoRecording` | video-recording | `wired` | `video_pause` (`video.ts`) | Pauses video recording (also used by idle-cut) |
| `Browser.recordingEnded` | fetch-and-recording | `wired` | `record_start` / `record_stop` (`browser.ts`) | Event when a HAR traffic recording finishes or hits its limit |
| `Browser.recordingMask` | fetch-and-recording | `excluded` | — | Secret redaction is intentionally out of scope for MCP |
| `Browser.recordingStatus` | fetch-and-recording | `excluded` | — | MCP owns a single browser process and tracks recording state in `browser.ts` |
| `Browser.resumeVideoRecording` | video-recording | `wired` | `video_resume` (`video.ts`) | Resumes a paused video recording |
| `Browser.setVideoRecordingTarget` | video-recording | `wired` | `video_start` / `tab_select` (`video.ts`) | Follows the active tab during video recording |
| `Browser.startRecording` | fetch-and-recording | `wired` | `record_start` (`browser_tools.ts`) | Starts HAR traffic recording on the browser target |
| `Browser.startVideoRecording` | video-recording | `wired` | `video_start` (`video.ts`) | Starts browser-side WebM video recording |
| `Browser.stopRecording` | fetch-and-recording | `wired` | `record_stop` (`browser.ts`, `browser_tools.ts`, `server.ts`) | Stops HAR traffic recording and flushes the archive |
| `Browser.stopVideoRecording` | video-recording | `wired` | `video_stop` (`server.ts`, `video.ts`) | Stops video recording and finalises the file and sidecar |
| `Browser.videoRecordingEnded` | video-recording | `wired` | `video_start` / `video_stop` (`browser.ts`) | Event when video recording ends (limit reached, tab closed, or error) |
| `Browser.videoRecordingStatus` | video-recording | `wired` | `video_start` / `video_stop` (`video.ts`) | Queries live video recording state, frame/byte counts, and output path |
| `Input.actionOutcome` | input | `wired` | `click`, `hover`, `drag` (`browser.ts`) | Event reporting hit-test outcome and refusals from real-input dispatch |
| `Input.chooseFiles` | input | `wired` | `upload` (`actions.ts`) | Attaches local files to a file input through the browser's file chooser path |
| `Input.dispatchKeyChord` | input | `wired` | `press`, `type` (`actions.ts`) | Sends key chords and special keys on the real-input path |
| `Input.dispatchKeystrokes` | input | `wired` | `type` (`actions.ts`) | Human-timed keystroke typing and scripted bursts |
| `Input.dispatchMousePath` | input | `excluded` | — | Low-level raw mouse-path command; MCP uses higher-level `Input.moveTo` and `Input.performDrag` |
| `Input.dispatchPaste` | input | `wired` | `paste` (`actions.ts`) | Pastes text through the browser's paste path |
| `Input.fillDateTime` | input | `wired` | `fill_date` (`actions.ts`) | Sets native date/time inputs |
| `Input.moveTo` | input | `wired` | `click`, `hover` (`actions.ts`) | Human-timed cursor movement and clicks on the real-input path |
| `Input.performDrag` | input | `wired` | `drag` (`actions.ts`) | Human-timed drag and drop between elements or points |
| `Input.permissionPromptDismissed` | chrome-extras | `wired` | all actions (`browser.ts`) | Event surfaced in action replies when the browser auto-dismisses a permission prompt |
| `Input.pickColor` | input | `wired` | `pick_color` (`actions.ts`) | Sets native colour picker inputs |
| `Input.probeMovementPersona` | input | `excluded` | — | Internal RNG parity probe between Chromium and NoDriver4j's `MovementPersona`, not an agent tool |
| `Input.readClipboard` | chrome-extras | `wired` | `clipboard` (`actions.ts`) | Reads the browser's private clipboard |
| `Input.readFocusedField` | input | `wired` | `type`, `press`, `paste` (`actions.ts`, `browser.ts`) | Verifies focus (`expect_focus`) and reads focused field text for burst checks |
| `Input.revealElement` | input | `wired` | `click`, `hover`, `type`, `select`, `scroll` (`actions.ts`) | Scrolls an element into view on the real-input path before acting |
| `Input.scrollBy` | input | `wired` | `scroll` (`actions.ts`) | Human-timed wheel scrolling |
| `Input.selectOptions` | input | `wired` | `select` (`actions.ts`) | Selects options in native `<select>` elements |
| `Input.writeClipboard` | chrome-extras | `wired` | `clipboard` (`actions.ts`) | Writes to the browser's private clipboard |
| `Page.agentAnnouncements` | perception | `excluded` | — | NoDriver `LiveRegionLines` poller; MCP reads listing and dialog deltas from `Page.captureAgentSnapshot` and `Page.agentSettle` |
| `Page.agentCanvasText` | canvas-text | `wired` | `observe`, `click`, `hover`, `drag` (`canvas.ts`) | Reads 2D canvas text runs, bounds, fills, and `untrackedBitmap` flags |
| `Page.agentFinishCapture` | perception | `excluded` | — | Two-phase screenshot secret redaction; secret redaction is intentionally out of scope for MCP |
| `Page.agentHitCheck` | perception | `excluded` | — | Low-level hit test; MCP relies on `Page.resolveAgentNode` and `Input.actionOutcome` |
| `Page.agentMarkSecretField` | video-recording | `excluded` | — | Marks DOM fields for video secret redaction; secret redaction is intentionally out of scope for MCP |
| `Page.agentNavigateToHistoryEntry` | perception | `wired` | `navigate` (`actions.ts`) | Navigates back and forward through tab session history |
| `Page.agentNodesAlive` | perception | `wired` | all element actions (`actions.ts`) | Checks whether previously listed element labels still exist on the active document |
| `Page.agentReport` | perception | `excluded` | — | NoDriver combined post-action frame/layer report; MCP composes replies from `Page.agentSettle`, `Page.captureAgentSnapshot`, and `Page.agentNodesAlive` |
| `Page.agentSettle` | perception | `wired` | all actions (`actions.ts`) | Waits for page settle after an action and reports navigation/network/DOM summary |
| `Page.agentSettleArm` | perception | `wired` | all actions (`actions.ts`) | Arms settle tracking before dispatching an input action |
| `Page.captureAgentSnapshot` | perception | `wired` | `observe`, `view`, all actions (`actions.ts`) | Captures the structured interactive listing, dialogs, and optional JPEG viewport |
| `Page.resolveAgentNode` | perception | `wired` | all element actions (`actions.ts`) | Resolves a listed element label to its current viewport box and live state before acting |
| `Page.startFrameStream` | fetch-and-recording | `excluded` | — | Shared-memory live frame stream for NoDriver's desktop GUI viewer only |
| `Page.stopFrameStream` | fetch-and-recording | `excluded` | — | Shared-memory live frame stream for NoDriver's desktop GUI viewer only |
| `Page.updateFrameStream` | fetch-and-recording | `excluded` | — | Shared-memory live frame stream for NoDriver's desktop GUI viewer only |
<!-- parity-table:end -->

## NoDriver4j tool concepts to `chromaphore-mcp` mapping

Reference source: `C:\Users\leofo\IdeaProjects\NoDriver4j\src\main\java\org\nodriver\agent\tools\ToolNames.java`.

### Browser lifecycle, tabs, and navigation

| NoDriver4j / Bridge concept | Status | `chromaphore-mcp` tool(s) | Notes |
|---|---|---|---|
| Browser install | `mcp-only` | `browser_install` | Downloads and verifies latest Chromaphore portable release from GitHub |
| `open_browser` / `close_browser` (bridge) | `wired` | `browser_open`, `browser_close` | Profile management (`default`, named, `temp`), headless/headed, seed |
| `list_tabs`, `switch_tab`, `close_tab` | `wired` | `tab_list`, `tab_new`, `tab_select`, `tab_close` | Full tab lifecycle including new tabs |
| `navigate`, `go_back`, `reload` | `wired` | `navigate` | `navigate` handles URLs plus `back`, `forward`, and `reload` |

### Observation, reading, and capture

| NoDriver4j / Bridge concept | Status | `chromaphore-mcp` tool(s) | Notes |
|---|---|---|---|
| `where_am_i`, `read_links`, `read_text`, `find_text` | `wired` | `observe`, `view` | `observe` returns interactive listing + page/canvas text (`offscreen`, `scope`); `view` adds scaled JPEG screenshot with `snapshot_id` |
| `screenshot` | `wired` | `screenshot` | Saves a full-page or viewport PNG/JPEG to disk |
| `wait`, `wait_for` | `excluded` | — | Every MCP action runs `Page.agentSettle`; explicit sleeps are rarely needed and `observe` / `eval_js` cover custom waits |
| `print_to_pdf` | `excluded` | — | Not requested for MCP; can be added over stock `Page.printToPDF` if needed |

### Input, forms, dialogs, and script

| NoDriver4j / Bridge concept | Status | `chromaphore-mcp` tool(s) | Notes |
|---|---|---|---|
| `click`, `hover` | `wired` | `click`, `hover` | Support element id, `(x, y)` point (`snapshot_id`), or canvas text aiming (`text`) |
| `type`, `clear` | `wired` | `type` | `type` supports `replace` (select-all + replace), `submit`, scripted bursts, and `expect_focus` |
| `press_key` | `wired` | `press` | Key chords and special keys |
| `paste_text` | `wired` | `paste` | Browser-side paste |
| Private clipboard | `mcp-only` | `clipboard` | Reads/writes Chromaphore's `--private-clipboard` |
| `scroll_by`, `scroll_to_element` | `wired` | `scroll` | Element actions auto-reveal via `Input.revealElement`; `scroll` scrolls by delta |
| `select_option` | `wired` | `select` | Native `<select>` options |
| Native date / colour inputs | `mcp-only` | `fill_date`, `pick_color` | Wired to `Input.fillDateTime` and `Input.pickColor` |
| `fill_form` | `excluded` | — | Batch form helper in NoDriver (paired with checkout profiles/secrets); MCP calls `type`/`select`/`click` directly |
| `drag` | `wired` | `drag` | Supports element ids, `(x, y)` points, or canvas text spans |
| `upload_file` | `wired` | `upload` | Wired to `Input.chooseFiles` |
| `handle_dialog` | `wired` | `dialog` | Accepts or dismisses JS alert/confirm/prompt dialogs |
| `eval_js` | `wired` | `eval_js` | Evaluates JS in the page's main world |

### Page reads, recording, video, and fingerprint

| NoDriver4j / Bridge concept | Status | `chromaphore-mcp` tool(s) | Notes |
|---|---|---|---|
| `fetch_url` (bridge) | `wired` | `fetch` | Wired to `Browser.agentFetch`, with optional `save_to` |
| `record_start`, `record_stop` | `wired` | `record_start`, `record_stop` | Wired to `Browser.startRecording` / `stopRecording` |
| `video_start`, `video_pause`, `video_resume`, `video_mark`, `video_stop` | `wired` | `video_start`, `video_pause`, `video_resume`, `video_mark`, `video_stop` | Wired to all 7 `Browser.*VideoRecording` commands/events, with optional idle-cut |
| Fingerprint report | `mcp-only` | `fingerprint` | Wired to `Browser.getFingerprint` |

### Intentionally excluded NoDriver-only families

| NoDriver4j / Bridge concept | Status | Reason |
|---|---|---|
| `type_secret` | `excluded` | Secret redaction and secret vaults are intentionally out of scope for MCP |
| `save_checkpoint`, `restore_to_checkpoint` | `excluded` | Longhaul agent task-checkpoint workflow, not a standalone MCP browser primitive |
| `crash_test` | `excluded` | NoDriver diagnostic tool only |
| Checkout profiles, proxies, IMAP, SMS, multi-agent bridge | `excluded` | NoDriver application services outside browser-driving MCP scope |
