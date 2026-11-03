# Design notes

Why the server works the way it does. The code comments point here.

## Talking to the browser

- **The debugging pipe, not a port.** The server starts `chrome.exe` with `--remote-debugging-pipe`: commands go to the browser's file descriptor 3 and answers and events come back on 4, one JSON message per NUL-terminated line (`server/src/cdp.ts`). No local port is open for other programs to find, and there is no stderr to parse.
- **Started outside the server's process tree.** Node on Windows ties every child it starts without `detached` to itself, so the browser would die with the server however the server ends; Claude Code also kills a server's whole process tree 300 ms after closing its stdin at the end of a session. The server therefore starts the browser through a short launcher process (`server/src/launcher.ts`) that starts `chrome.exe` detached, hands it its own descriptors 3 and 4, prints the pid and exits. When the server goes, the pipe closes and the browser closes itself cleanly (Chromium's pipe handler calls `CloseBrowserSoon`): measured about 0.1 s later, profile `exit_type` Normal. On stdin close the server also stops a running recording and sends `Browser.close`. (`server/spikes/spike_shutdown.mjs`)
- **One flat session per tab, for the tab's life.** The custom commands keep per-session state (the pointer, the settle arm), and the human-timed Input commands run only on the tab's own session, never an iframe's.
- **No `Runtime.enable`.** `Runtime.evaluate` and `Runtime.callFunctionOn` work without it, and isolated worlds come from `Page.createIsolatedWorld`. On v156 enabling it showed nothing a page could see (below), but the server needs nothing from it.

## Launch switches

Always (`server/src/browser.ts`, `BASE_SWITCHES`):

- `--remote-debugging-pipe`, `--user-data-dir`, `--fingerprint-seed=<n|auto>`, `--no-startup-window`.
- `--disable-hang-monitor`: no "page unresponsive" dialog nobody can answer.
- `--auto-decline-webauthn`, `--dismiss-permission-prompts`, `--cancel-print-preview`, `--cancel-payment-request`: prompts nobody at the window can answer are closed as a person would (permissions dismissed, nothing remembered; print previews and payment sheets cancelled).
- `--private-clipboard`: the browser's own clipboard, so the machine's (the user's) is never read or overwritten; `paste` uses it.
- `--disable-auto-reload`: a network-error page stays as it is instead of reloading itself unseen.
- `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows`, `--disable-background-timer-throttling`: tabs the agent is not looking at keep running at full speed.
- `--disable-features=Prerender2,UseEcoQoSForBackgroundProcess,AvoidUnnecessaryBeforeUnloadCheckSync`: no hidden prerendered pages or extra targets under the agent; background processes off Windows' efficiency mode. (AI Mode's eligibility request to google.com at every launch, `AimEnabled`, the browser's own preset disables from Chromeleon 1.0.0 on.)
- Headless only: `--headless=new`, `--mute-audio`, `--enable-gpu`, `--fingerprint-screen=auto`, `--fingerprint-screen-position=auto` (the seed's screen; headed shows the real monitor and window, which must agree).

Never: `--enable-automation` (shows the "controlled by automated test software" bar), `--disable-ipc-flooding-protection` (a page can count `history.replaceState()` calls: Chrome lets 200 through in 10 s, the switch all of them), `--disable-renderer-accessibility` (starves the page snapshot), `--remote-debugging-port` (the pipe replaces it).

The browser itself already adds a preset on every launch (first-run, sync, telemetry and background-traffic switches, `--hide-crash-restore-bubble`), so the server does not repeat it.

## Automation signals

`server/spikes/spike_signals.mjs` loads `server/spikes/automation_probe.html` in five setups, with and without a window: a person's launch (profile and seed only), the server's switches without debugging, and the server's switches driven over the pipe, over a port, and over the pipe with `Runtime.enable`. The driven runs do what the server does (settle, a listing with a screenshot, an evaluate, two human clicks, typing). The page checks `navigator.webdriver`, the outer-minus-inner window sizes, focus and visibility, plugins, languages, `window.chrome`, notification permission against the permissions query, connection RTT, the WebGL renderer, media devices, voices, globals beyond a fresh frame's, `debugger`-statement timing, accepted `history.replaceState()` calls, and seven console-preview traps (getters on an Error's `stack` and `message`, an object, an array index, `Symbol.toStringTag`, `constructor`, and a Proxy's traps).

On Chromeleon 156 no driven run differs from a person's launch, headed or headless. Three of the traps fire in every setup alike, because the browser turns console arguments into text whether or not anything is attached. Input arrives trusted, with a curved path of 140 to 280 mouse moves before a click and 150 to 420 ms between keys.

Seen on the way, and not signals: a page's first script sees a 0x0 outer window, position 0,0 and no focus whenever it is not the tab's first page, with or without any debugging switch, in stock Chrome as here (`spike_window2.mjs`); the real values arrive within 2 s.

## Acting and settling

- An element is acted on in three steps: `Page.resolveAgentNode` (its node and local root frame), `Input.revealElement` (scrolled into view with the wheel), then the action (`Input.moveTo` with a click, `selectOptions`, `fillDateTime`, ...).
- The server keeps a copy of the pointer per tab from every answer and sends it with every pointer command; a tab's first command sends the view's centre. "The pointer is outside the page's view" moves it to the centre and retries once; a landing that was covered is re-aimed once.
- Every action ends with `Page.agentSettle` on the action's own id, then a listing with `since` the tab's previous one, so the answer says what changed. "Not the current action" settles again without the id.
- For a moment after a commit, Page commands answer "Not attached to an active page" until the session has moved to the new document; the server retries them for up to 3 s.
- A JavaScript dialog blocks the page: an action that opens one answers at once with its text instead of waiting on a page that cannot answer.
- Typing: 60 to 260 ms between keys, a thinking pause now and then, a rare typo corrected at once, never in passwords, numbers, codes or card fields; `exact` turns typos off.

## Profiles

A new profile is a folder under `%LOCALAPPDATA%\Chromeleon\profiles\`, not in Claude Code's plugin data folder, which is deleted with the plugin; profiles hold logins. A profile in use by another running browser is refused (its `lockfile` cannot be removed).
