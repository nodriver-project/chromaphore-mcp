---
name: install
description: Download and install the Chromeleon browser the plugin drives.
disable-model-invocation: true
---

# Install the Chromeleon browser

Tell the user, before anything is downloaded:

- The latest release comes from https://github.com/pppi21/Chromeleon-Browser/releases and is about 1.6 GB (most of it the font bundle that makes the reported fonts consistent).
- It is unpacked under `%LOCALAPPDATA%\Chromeleon\browser\`, checked against the SHA-256 GitHub publishes for it, and is not registered with Windows (it does not become a default browser).
- Profiles the browser tools create go under `%LOCALAPPDATA%\Chromeleon\profiles\`.

If they agree, call the `browser_install` tool and report its answer.

Then tell them how to let the browser tools run without a prompt on every call: add this to `permissions.allow` in `~/.claude/settings.json` (all projects) or `.claude/settings.json` (this project):

```json
"mcp__plugin_chromeleon_browser__*"
```

If they already have Chromeleon installed elsewhere, they can skip the download: `/config`, then the Chromeleon plugin's "Browser" option, set to that `chrome.exe`.
