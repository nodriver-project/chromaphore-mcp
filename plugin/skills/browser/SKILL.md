---
name: browser
description: How to drive the Chromaphore browser tools well — testing or debugging a web app, reproducing a bug with real input, checking a page as a visitor sees it, or reading a site through a real browser. Load before the first browser_open in a task.
---

# Driving the Chromaphore browser

The browser tools act like a person at a real browser: the pointer travels to what it clicks, the wheel scrolls, keys are typed at a human pace. Pages see trusted input and an ordinary Chrome. That makes the tools right for reproducing what users hit; it also means actions take human time (a click about a second, typing about six characters a second).

## The loop

1. `browser_open` with the `url` to start on. Pick `headless: true` for background checks the user does not need to watch; leave it off when they want to see the browser, or when a site behaves differently without a window.
2. Act with `click`, `type`, `press`, `scroll`, `hover`, `navigate`. Each waits until the page has settled and answers with what changed: `+` lines appeared, `-` lines went, `~` lines changed (a value, a name, a state), plus focus, URL, scroll and announcements. That is usually all you need to plan the next step.
3. Call `observe` when you need the whole page again (after several changes, or a page you have not listed yet). Call `view` with a `snapshot_id` only when text is not enough: layout, images, colours, a canvas. It costs about 1,500 tokens.
4. `browser_close` when done. The profile stays on disk, unless it was `temp`.

Send calls whose targets you already know one after another without observing in between: an id from a page the tab has since left, or of an element that went, is refused with the reason rather than acting on the wrong element.

## Ids and the listing

Each line starts with an id like `a12`, then the role, the accessible name in quotes, the value, the states that matter (focused, checked, disabled, required, invalid with the page's message), a link's destination, and where it is when not in view. `[red]` is the colour of its outline on the `view` screenshot. An id stays valid for the element's whole life in the document, across scrolls and listings.

Each page gets its own letters: `a12` on one page, `b12` on the next (after a navigation, a reload, or in another tab), and so on; read the ids off the latest listing. A page that reloads itself (a cookie banner often does) is a new page; one restored by going back keeps its letters, and its ids work again. The `view` screenshot's badges always read `a12`; on a later page `view` says which letters they stand for.

Elements outside the view can be clicked directly: the click scrolls them in first. Elements marked covered cannot: close what covers them (a cookie banner, a dialog, a menu) first. `Open on top:` lines name dialogs, drawers and menus; with one open, only its contents are listed unless you observe with `scope: "all"`.

## Forms

- `type` with an `id` clicks into the field first. `clear: true` replaces what it holds; `submit: true` presses Enter after.
- Rare typos are typed and corrected like a person's, never in passwords, numbers, one-time codes or card fields. Use `exact: true` when even a corrected typo would matter (a field that validates on every key).
- Native controls have their own tools, which work them as a person does and check the result: `select` (by visible text or value; a wrong one is refused with the options there are), `fill_date` (`2024-05-03`, `14:30`, `2024-05-03T14:30`, `2024-05`, `2024-W18`), `pick_color` (`#rrggbb`), `upload` (absolute or working-folder paths; the field, its label or the button that opens it), `drag` (onto an element, a point, or a slider's `value`). Use them rather than typing into such fields.
- `paste` is quicker than `type` for long text and is a real paste to the page.
- The listing shows each field's value afterwards; check it rather than assuming.
- A JavaScript `alert`, `confirm` or `prompt` blocks the page: the action that opened it says so, and you answer with `dialog`.

## Editors that draw their own text (Google Docs)

Google Docs draws each page on a canvas: the listing shows the body as `Canvas` lines with no text, and an element click on them is refused. Work there by points and keys:

- `click` with `x` and `y` (CSS pixels of the view) clicks at a point: between two characters it puts the caret there; `count: 2` takes a word, `count: 3` a paragraph, `modifiers: ["Shift"]` extends the selection. `drag` with `from_x`, `from_y` to `x`, `y` selects what lies between; its answer says "pointer drag, released". Points must be inside the view and nothing scrolls to them: bring the place into view with `scroll`, and read positions off a fresh `view`. A drag from a point to an element (`to`) scrolls to the element if it needs to. A drag between two points inside a frame of another site is refused (a click at a point there works). On a large view the image is smaller than the view, and `view` says so with its scale: pass the point as you read it off the image together with its `snapshot_id`, or divide it by the scale.
- A point read off the image is good to a few pixels: enough for a word (double click) or a line, not for the boundary between two letters. Reach an exact spot with keys from a known one: `Home`, `End`, `Ctrl+ArrowLeft`/`Ctrl+ArrowRight`.
- A press on text that is already selected drags that text in an editor instead of starting a new selection: the answer then says "native drag, dropped", and the text has moved. Collapse the selection first: an arrow key, or a click elsewhere.
- Keys go to the listed `textbox "Document content"`. Pass its id as `expect_focus` to `type`, `press` and `paste`: Docs opens boxes that take the focus (a Gemini prompt opens when text is selected), and then nothing is sent; the refusal names what has the focus. The focus is checked once, right before the first key, not during a long burst.
- Use `quiet: true` on actions there: each key changes much of the listing, and the quiet answer still says what opened on top and where the focus went.
- `type` with `keys` plays a burst as scripted: strings, `{"bs": 3}`, `{"pause_ms": 800}`, `{"press": "Ctrl+I"}` (italics on or off; a shortcut's key is a named key or one ASCII character, so type other characters as text). Give `keys` or `text`, not both. The answer says what the burst leaves (a plain `{"press": "Enter"}` counts as a newline), unless it presses keys whose effect on the text cannot be followed (arrows, Delete, Ctrl+A, Ctrl+V, Ctrl+Z). If a step fails midway, the answer says what went out before it.
- Docs changes what you type by its own substitutions (Tools > Preferences): `"` becomes `“` or `”`, `--` an en dash, `...` an ellipsis, `(c)` ©, `1/2` ½. `paste` puts in plain text, which takes the formatting at the caret.
- The document's exact text: `fetch` its export, `https://docs.google.com/document/d/<id>/export?format=txt`, or `format=docx` with `save_to` for the formatting (an HTML page with `save_to` is saved as the Markdown `fetch` renders it to, unless `mode: "raw"`). It is the saved state, so wait for "Saved to Drive" first.

## Reading state

`eval_js` evaluates an expression in the page and returns JSON: use it for application state, `localStorage`, computed values, or checking what the DOM holds. Do not use it to click or type: script events are not trusted input and miss what the page does on real input.

`fetch` reads a URL through the same browser (its cookies, fingerprint and network) without opening a tab: a page as Markdown, JSON or text as it is, or an API call with a method, headers and a body. Prefer it to navigating when you only need a page's content. It says when a bot challenge or a block got in the way.

`record_start` / `record_stop` capture everything the browser sends and receives, from inside it, to a folder with a HAR, a grep-able `requests.txt` and a `summary.md`. Use it to see which requests a page makes, what an API returned, or why something failed. The files hold cookies: keep them out of version control.

`screenshot` saves a PNG for the user or for a bug report (the model sees nothing); `view` is for you. `fingerprint` says what this launch shows sites about the machine.

## Profiles and fingerprints

`browser_open` answers with the profile path and the fingerprint seed. Pass `profile` back to reuse cookies and logins (for testing a signed-in flow, sign in once, then reuse the profile); pass `seed` back to keep the same fingerprint, which sites expect from a returning visitor. A fresh profile with a random seed is a first-time visitor.

For a one-off check you will not come back to, pass `profile: "temp"`: a fresh profile deleted when the browser closes, so test runs do not pile up profile folders. Its downloads and the files `fetch` saves go with it: copy out what you need before `browser_close`.

A profile can be open in one browser at a time.
