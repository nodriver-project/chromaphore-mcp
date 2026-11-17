---
name: replay
description: How to replay input your own pipeline planned (a start time, a typing seed, a burst checked against the text it must leave) with the Chromaphore browser tools; applies only with the plugin's "Replay options" setting on.
---

# Replaying planned input

With the plugin's **Replay options** setting on, `type`, `press` and `paste` take three more options, for input whose values come from a pipeline of your own rather than from the page. With it off they are not offered, and a call that passes them is refused. Everything in the `chromaphore:browser` skill applies as well.

- `not_before` holds the first key or paste until a time: ISO 8601 with its zone (`2026-11-16T21:50:00.000Z`) or epoch milliseconds, at most 15 minutes ahead. Place the caret first (a click into `id` happens at once; a point click before the call), so only the keys wait. The answer adds a line "Ran from … to …" with when the input went out. Everything that can be refused is refused before the wait: the time, the burst, the `expect_focus` id. `expect_focus` is checked after the wait, right before the first key. Cancelling the call during the wait sends nothing.
- `seed` on `type`: the same seed, text and `speed` give the same rhythm of the typed strings, and the same gaps between a burst's steps. Key presses and Backspaces are timed afresh by the browser each call.
- `type` with both `keys` and `text`: `text` is what the burst must leave, checked before anything is sent; a burst that leaves something else is refused with what it would leave. A plain Enter, Tab or Space press counts as the character it types, a plain Backspace as one `bs`. Presses whose effect the check cannot follow (arrows, Delete, Ctrl+A, Ctrl+V, Ctrl+Z) and Backspaces that reach before the burst's start are refused with `text`: leave `text` out to play such a burst unchecked.
