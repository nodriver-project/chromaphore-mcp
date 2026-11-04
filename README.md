# chromeleon-mcp
[![Discord](https://img.shields.io/discord/1499516872758923264?logo=discord&label=Discord)](https://discord.gg/EdRx3832Hw)

**Support:**  [Discussions](https://github.com/nodriver-project/chromeleon-mcp/discussions) · [Browser releases](https://github.com/nodriver-project/Chromeleon-Browser/releases)

A Claude Code plugin that drives the [Chromeleon browser](https://github.com/nodriver-project/Chromeleon-Browser), a Chromium build with human-timed input commands and a per-launch fingerprint, through its custom DevTools protocol commands.

What Claude gets:

- **A page listing with ids**, from the browser's own agent snapshot: roles, names, values, states, what is open on top, live-region announcements. After each action, only what changed.
- **Input a person would make**: the pointer travels to what it clicks and scrolls it into view with the wheel; typing is paced, with rare corrected typos. Pages see trusted events.
- **Profiles and fingerprints to come back to**: each launch answers with its profile folder and fingerprint seed.

Windows only for now, like the browser.

## Install

```
/plugin install chromeleon --marketplace nodriver-project/chromeleon-mcp
/chromeleon:install
```

The second command downloads the latest browser release (about 1.6 GB, mostly fonts) to `%LOCALAPPDATA%\Chromeleon`. To use a Chromeleon you already have instead, set the plugin's **Browser** option in `/config` to its `chrome.exe`.

The plugin needs [Node.js](https://nodejs.org) 20 or later on `PATH`.

Claude Code asks before every tool call of a new plugin. To let the browser tools run without asking, add to `permissions.allow` in `~/.claude/settings.json`:

```json
"mcp__plugin_chromeleon_browser__*"
```

## Tools

| Tool | What it does |
|---|---|
| `browser_install` | Downloads and unpacks the latest release, checked against its published SHA-256, replacing an older one; `check_only` reports what is installed and what the latest release is, and downloads nothing |
| `browser_open` / `browser_close` | Launches with a new, temporary or existing profile, a fixed or random fingerprint seed, with or without a window |
| `tab_list` / `tab_new` / `tab_select` / `tab_close` | Tabs, including those the page opens |
| `navigate` | A URL, back, forward or reload; answers with the settled page's listing |
| `observe` / `view` | The listing, and its screenshot with each element outlined and labelled |
| `click` / `hover` / `type` / `press` / `scroll` | Human-timed input; each answers with what changed |
| `select` / `fill_date` / `pick_color` / `upload` | Native controls worked as a person works them: the dropdown opened and clicked, the date typed part by part, the colour picker, the file chooser answered |
| `drag` | Native drag and drop, pointer-driven libraries and sliders, with a real carry |
| `paste` | A real Ctrl+V from the browser's own clipboard (the machine's is never touched) |
| `dialog` | Answers an alert, confirm or prompt |
| `fetch` | Reads a URL through the browser without a tab: HTML as Markdown, anything else as text, or an API call from the site's own origin; reports bot challenges |
| `record_start` / `record_stop` | Records all the browser's traffic from inside it: HAR with bodies, a request index, a summary |
| `fingerprint` | What the browser shows sites about the machine for this launch |
| `eval_js` | Evaluates an expression in the page |
| `screenshot` | Saves a PNG to a file |

Requires Chromeleon 156 or later.

## Where things live

- `%LOCALAPPDATA%\Chromeleon\browser\<release>\`: the browser.
- `%LOCALAPPDATA%\Chromeleon\profiles\`: profiles the tools created. Each holds that profile's cookies and logins; delete a folder to forget it.
- `%LOCALAPPDATA%\Chromeleon\temp\`: temporary profiles while their browser runs; each is deleted when its browser exits.

The browser is started outside Claude Code's process tree and closes itself cleanly when the session ends.

## Layout of this repository

- `.claude-plugin/marketplace.json`: the repository is its own marketplace.
- `plugin/`: what Claude Code installs: the manifest, the MCP server config, the bundled server (`dist/`), the skills.
- `server/`: the server's TypeScript source; `npm install`, then `node build.mjs` bundles it into `plugin/dist/` and writes `plugin/THIRD_PARTY_NOTICES.md`, `plugin/LICENSE` and `plugin/NOTICE`.
  - `server/test/`: `smoke.mjs` and `phase2.mjs` drive the bundled server over stdio through every tool on local test pages (`node test/smoke.mjs <chrome.exe>`); `claude_session.mjs` loads the plugin into a real `claude -p --plugin-dir` session and checks the browser closes cleanly afterwards (with `--temp`, that its temporary profile is deleted); `temp_profile.mjs` checks temporary profiles are deleted after `browser_close` and after the session ends; `install.mjs` runs `browser_install`.
  - `server/spikes/`: the experiments the design rests on (the pipe, shutdown, automation signals, window values, ECH). They take the browser from `CHROMELEON_BROWSER` or the installed release.
- `docs/DESIGN.md`: why the server works the way it does: the pipe, the launch outside the process tree, every launch switch, the automation-signal results, how actions settle.

## License

[Apache License 2.0](LICENSE); see also [NOTICE](NOTICE). The npm packages bundled into the server keep their own licenses ([notices](plugin/THIRD_PARTY_NOTICES.md)); the browser has its own license in its repository.
