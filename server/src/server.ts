// The MCP server Claude Code starts: browser tools over the Chromaphore
// browser's custom CDP commands. Design notes: docs/DESIGN.md.
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as act from './actions.js';
import { Browser, ToolError } from './browser.js';
import * as whole from './browser_tools.js';
import { CdpError } from './cdp.js';
import { checkInstall, install } from './install.js';
import { moveFromChromeleon, removePendingReleases, sweepPageCounts } from './paths.js';

const VERSION = '0.3.0';

// The replay options (not_before, type's seed, and a burst's check against
// the text it must leave) need values only a caller's own pipeline makes, so
// they are behind the plugin's replay_options setting, off by default
// (docs/DESIGN.md, "General and replay options"). Claude Code substitutes a
// boolean option as "true" or "false"; an absent, empty or unsubstituted
// value (the literal ${user_config.replay_options}) is off.
const REPLAY = /^(true|1)$/i.test((process.env.CHROMAPHORE_REPLAY_OPTIONS ?? '').trim());
const SETTING = 'the plugin\'s "Replay options" setting (replay_options)';

// How to use the replay options, sent only with the setting on. It lives
// here rather than in a skill because a skill's description is listed to
// every agent, setting or not (docs/DESIGN.md, "General and replay options").
const REPLAY_GUIDE = `The replay options are on, for input whose time or text a pipeline of your own planned. not_before (type, press, paste) holds the first key or paste until a time at most 15 minutes ahead: place the caret first (the click into id happens at once; click a point in an earlier call), so only the keys wait. Everything that can be refused (the time, the burst's steps and text check, the expect_focus id) is refused before the wait, never after it; the focus itself is checked after the wait, right before the first key, and cancelling during the wait sends nothing. seed on type: the same seed, text and speed repeat the rhythm of the typed strings and the gaps between a burst's steps, but not the timing of key presses and Backspaces, which the browser draws afresh each call. type with both keys and text checks, before any key, that the burst leaves exactly text: a plain Enter, Tab or Space press counts as its character and a plain Backspace as one bs; a burst with presses the check cannot follow (arrows, Delete, Ctrl+A, Ctrl+V, Ctrl+Z) or with Backspaces reaching before its start is refused, so leave text out to play it unchecked.`;

const INSTRUCTIONS =`Tools for driving the Chromaphore browser, a Chromium build whose input is timed like a person's and whose fingerprint is set per launch. Use them to test or debug a site, reproduce a bug with real input, or read pages through a real browser.

Loop: browser_open, then navigate. Every action (click, type, press, scroll, hover, navigate) waits for the page to settle and answers with what changed, so you rarely need observe after one. Call observe for a full listing of the page; call view only when the text is not enough (it costs about 1,500 tokens).

Elements are named by ids like a12 from the listings. Each page gets its own letters (a12 on one page, b12 on the next after a navigation, a reload or in another tab); a page restored by going back keeps its letters. An id stays valid while its element is on its page, across scrolls and later listings; one from a page the tab has left, or a gone element, is refused with the reason, never used on another element. Clicks move a real pointer along a curved path and scroll the element into view first; typing is human-paced, so long texts take seconds.

A JavaScript dialog blocks the page until answered with dialog. The listing marks elements outside the view and covered elements; act on covered ones only after closing what covers them.

Where there is no element to aim at, such as text an editor draws itself (Google Docs draws each page on a canvas), click, hover and drag also take a point of the view (x, y) in CSS pixels; a point read off view's image goes with its snapshot_id when view says the image is scaled. Typing can be a scripted burst (keys)${REPLAY ? ', wait for a time (not_before)' : ''} and check once, before the first key, that a given element has the focus (expect_focus).
${REPLAY ? `
${REPLAY_GUIDE}
` : ''}
Native controls have their own tools (select, fill_date, pick_color, upload, drag); use them rather than typing into such fields. To read a page or call an API without a tab, use fetch. To see a page's network traffic, wrap the steps in record_start and record_stop. The skill chromaphore:browser has more.`;

const server = new McpServer({ name: 'browser', version: VERSION }, { instructions: INSTRUCTIONS });
let browser: Browser | null = null;

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

const text = (t: string, isError = false): Result => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

function current(): Browser {
  if (!browser || browser.closed) throw new ToolError('No browser is open. Call browser_open.');
  return browser;
}

async function guard(fn: () => Promise<Result | string>): Promise<Result> {
  try {
    const r = await fn();
    return typeof r === 'string' ? text(r) : r;
  } catch (e) {
    if (e instanceof ToolError) return text(e.message, true);
    if (e instanceof CdpError) return text(`${e.method} failed: ${e.message}`, true);
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

const id = z.string().describe('An element id from a listing, such as a12.');
const px = (what: string) =>
  z.number().describe(`${what}, in CSS pixels of the view; with snapshot_id, in pixels of that snapshot's image.`);
const snapshotId = z
  .string()
  .optional()
  .describe("The snapshot whose image the point was read off (s3): the point is then in that image's pixels, which view's note gives when they are not the view's CSS pixels. It must be of this tab's current page.");
const quiet = z
  .boolean()
  .optional()
  .describe('Answer without the changed elements (what opened on top, the focus and announcements stay); for pages such as Google Docs where every key changes much of the listing.');
const notBefore = z
  .union([z.string(), z.number()])
  .optional()
  .describe('Wait until this time before the first key or paste: ISO 8601 with its zone (2026-11-16T21:50:00.000Z) or epoch ms; at most 15 minutes ahead. Clicking into id happens at once. The answer then says when the input ran.');
const expectFocus = id
  .optional()
  .describe(`Send nothing unless this element has the keyboard focus right before the first key (in Google Docs, the "Document content" textbox). Checked once, before the first key${REPLAY ? ' and after any not_before wait' : ''}; a refusal names what has the focus. Not for an element in a frame of another site or origin, which the check cannot read.`);
// The replay options of a tool, only with the setting on. Typed as always
// there, so the handlers read them as they would with it on; with it off
// they are refused before they are read (refuseReplay).
const replayOnly = <S extends z.ZodRawShape>(shape: S): S => (REPLAY ? shape : ({} as S));
// type, press and paste take a loose object with the setting off: the SDK's
// own object from a raw shape strips keys it does not list, and a not_before
// stripped so would send at once. Kept, they reach the handler, which refuses
// them by name. With the setting on the object is the SDK's, as before.
const inputOf = <S extends z.ZodRawShape>(shape: S) => (REPLAY ? z.object(shape) : z.looseObject(shape));
function refuseReplay(args: Record<string, unknown>, names: string[]): void {
  if (REPLAY) return;
  const given = names.filter((n) => Object.hasOwn(args, n));
  if (given.length) {
    throw new ToolError(`Nothing was sent: ${given.join(' and ')} ${given.length > 1 ? 'are' : 'is'} available only with ${SETTING} turned on. Leave ${given.length > 1 ? 'them' : 'it'} out to act now.`);
  }
}
const point = (args: { id?: string; x?: number; y?: number; snapshot_id?: string }, verb: string): act.Point | null => {
  const hasPoint = args.x !== undefined || args.y !== undefined;
  if (args.id && hasPoint) throw new ToolError(`${verb} an element (id) or a point (x and y), not both.`);
  if (args.id) {
    if (args.snapshot_id) throw new ToolError('snapshot_id is for a point (x and y) read off its image, not for an id.');
    return null;
  }
  if (args.x === undefined || args.y === undefined) throw new ToolError(`Say what to ${verb.toLowerCase()}: id, or x and y.`);
  return { x: args.x, y: args.y };
};
// A point given in a snapshot's image pixels, made a point of the view.
const inView = (tab: Awaited<ReturnType<Browser['tab']>>, p: act.Point | null, snapshot?: string): act.Point | null =>
  p && snapshot ? act.pointsOfImage(tab, snapshot, [p])[0] : p;

server.registerTool(
  'browser_install',
  {
    title: 'Install the browser',
    description:
      'Downloads the latest Chromaphore release from GitHub (about 1.6 GB with its fonts), checks its SHA-256 and unpacks it under %LOCALAPPDATA%\\Chromaphore, replacing an older installed release; downloads nothing when the latest is already installed. With check_only it only reports what is installed and what the latest release is, and never downloads: call that first, and ask the user before a call that would download. Not needed when a browser path is set in the plugin settings.',
    inputSchema: {
      check_only: z
        .boolean()
        .optional()
        .describe('Report the installed release and the latest one on GitHub; download nothing.'),
    },
  },
  (args, extra) =>
    guard(() =>
      args.check_only
        ? checkInstall()
        : install((done, total, message) => {
            const token = extra._meta?.progressToken;
            if (token !== undefined) {
              void extra.sendNotification({
                method: 'notifications/progress',
                params: { progressToken: token, progress: done, total, message },
              });
            }
          }, extra.signal),
    ),
);

server.registerTool(
  'browser_open',
  {
    title: 'Open the browser',
    description:
      'Launches the browser. Answers with the profile path and the fingerprint seed in use: pass them back on a later browser_open to return to the same cookies, logins and storage (profile) and the same fingerprint (seed). Headless runs without a window; headed (the default) lets the user watch.',
    inputSchema: {
      url: z.string().optional().describe('A page to open in the first tab.'),
      profile: z
        .string()
        .optional()
        .describe(
          '"new" (the default) for a fresh profile kept on disk; "temp" for a fresh one deleted when the browser closes, with its downloads and saved fetches; or the path of one a previous browser_open returned.',
        ),
      seed: z
        .number()
        .int()
        .min(-2147483648)
        .max(2147483647)
        .optional()
        .describe('Fingerprint seed: the same seed gives the same fingerprint. Omit for a random one.'),
      headless: z.boolean().optional().describe('Run without a window (default false).'),
    },
  },
  (args) =>
    guard(async () => {
      if (browser && !browser.closed) {
        return text('A browser is already open. Call browser_close first to open another.', true);
      }
      browser = await Browser.open({ profile: args.profile, seed: args.seed, headless: args.headless });
      const tab = await browser.newTab();
      const lines = [
        `Browser open: Chromaphore ${browser.version}, ${browser.headless ? 'headless' : 'with a window'}.`,
        browser.temp
          ? `Profile: temporary, deleted when the browser closes (${browser.profile})`
          : `Profile: ${browser.profile}`,
        `Fingerprint seed: ${browser.seed ?? 'unknown'}${browser.bundleActive === false ? ' (the font bundle is not active: system fonts)' : ''}`,
        `Tab ${tab.id} is open.`,
      ];
      if (args.url) lines.push('', await act.navigate(tab, { url: args.url }));
      return lines.join('\n');
    }),
);

server.registerTool(
  'browser_close',
  {
    title: 'Close the browser',
    description: 'Closes the browser cleanly. The profile keeps its state, unless it is temporary: then it is deleted.',
    inputSchema: {},
  },
  () =>
    guard(async () => {
      if (!browser || browser.closed) return 'No browser is open.';
      await browser.close();
      if (!browser.temp) return `Closed. Profile kept at ${browser.profile}`;
      // The launcher's reaper deletes it once the browser has exited.
      const deadline = Date.now() + 10_000;
      while (fs.existsSync(browser.profile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
      return fs.existsSync(browser.profile)
        ? `Closed. The temporary profile is deleted once the browser's last process exits (${browser.profile}).`
        : 'Closed. The temporary profile is deleted.';
    }),
);

server.registerTool(
  'tab_list',
  { title: 'List tabs', description: 'The open tabs, with ids, titles and URLs; the selected one is marked.', inputSchema: {}, annotations: { readOnlyHint: true } },
  () =>
    guard(async () => {
      const tabs = current().listTabs();
      if (!tabs.length) return 'No tabs are open.';
      return tabs.map((t) => `${t.active ? '*' : ' '} ${t.id} ${JSON.stringify(t.title)} ${t.url}`).join('\n');
    }),
);

server.registerTool(
  'tab_new',
  {
    title: 'Open a tab',
    description: 'Opens a tab and selects it; the other tools act on the selected tab.',
    inputSchema: { url: z.string().optional() },
  },
  (args) =>
    guard(async () => {
      const tab = await current().newTab();
      return args.url ? act.navigate(tab, { url: args.url }) : `Tab ${tab.id} is open and selected.`;
    }),
);

server.registerTool(
  'tab_select',
  {
    title: 'Select a tab',
    description: 'Brings a tab to the front and makes it the one the other tools act on. Tabs the page opened appear in tab_list.',
    inputSchema: { tab: z.string().describe('A tab id from tab_list, such as t2.') },
  },
  (args) => guard(async () => act.observe(await current().select(args.tab))),
);

server.registerTool(
  'tab_close',
  { title: 'Close a tab', description: 'Closes a tab.', inputSchema: { tab: z.string() } },
  (args) =>
    guard(async () => {
      await current().closeTab(args.tab);
      return `Closed ${args.tab}.`;
    }),
);

server.registerTool(
  'navigate',
  {
    title: 'Navigate',
    description:
      'Loads a URL in the selected tab, or goes back, forward or reloads, then waits for the page to settle and answers with its listing.',
    inputSchema: {
      url: z.string().optional(),
      action: z.enum(['back', 'forward', 'reload']).optional().describe('Instead of a URL.'),
    },
  },
  (args) =>
    guard(async () => {
      if (!args.url && !args.action) throw new ToolError('Give a url or an action.');
      return act.navigate(await current().tab(), args);
    }),
);

server.registerTool(
  'observe',
  {
    title: 'List the page',
    description:
      'Waits for the page to settle and lists it: one line per element with its id (a12), role, name, value, states and where it is; what is open on top (a dialog, a menu); and live-region announcements. Elements in view that can be acted on carry the [color] of their outline on the screenshot view shows.',
    inputSchema: {
      offscreen: z
        .enum(['none', 'summary', 'full'])
        .optional()
        .describe('Elements outside the view: none, summary (default: what can be acted on or is named), or full.'),
      scope: z
        .enum(['all'])
        .optional()
        .describe('all: also list elements behind what is open on top, which a click cannot reach.'),
    },
    annotations: { readOnlyHint: true },
  },
  (args) => guard(async () => act.observe(await current().tab(), args.offscreen, args.scope)),
);

server.registerTool(
  'view',
  {
    title: 'See the page',
    description:
      'The screenshot of a snapshot_id from observe or an action, each actionable element outlined with its id in a badge of the same color. Costs about 1,500 tokens; use it when the text listing is not enough (layout, an image, a visual state).',
    inputSchema: { snapshot_id: z.string() },
    annotations: { readOnlyHint: true },
  },
  (args) =>
    guard(async () => {
      const img = act.image(args.snapshot_id);
      const content: Content[] = [{ type: 'image', data: img.data, mimeType: img.mimeType }];
      const notes: string[] = [];
      // The browser draws its own labels, a1 on every page.
      if (img.letters !== 'a') {
        notes.push(`The badges read a12 and so on; on this page the ids are ${img.letters}12 and so on (badge a5 is ${img.letters}5).`);
      }
      const scale = act.scaleNote(img);
      if (scale) notes.push(scale);
      if (notes.length) content.push({ type: 'text', text: notes.join('\n') });
      return { content };
    }),
);

server.registerTool(
  'click',
  {
    title: 'Click',
    description:
      'Scrolls the element into view, moves the pointer to it along a human path and clicks; answers with what the click led to and what changed. A covered element is refused with what covers it. Or clicks at a point of the view (x, y) where there is no element to aim at, such as between two characters in text an editor draws itself (Google Docs): whatever is at the point takes the click, and nothing scrolls.',
    inputSchema: {
      id: id.optional(),
      x: px('A point to click instead of an element').optional(),
      y: px('Its y').optional(),
      snapshot_id: snapshotId,
      button: z.enum(['left', 'right', 'middle']).optional(),
      count: z.number().int().min(1).max(3).optional().describe('2 for a double click (a word), 3 for a triple (a paragraph).'),
      modifiers: z.array(z.enum(['Alt', 'Ctrl', 'Meta', 'Shift'])).optional().describe('Keys held during the click (Shift extends a selection).'),
      quiet,
    },
  },
  (args) =>
    guard(async () => {
      const tab = await current().tab();
      const p = inView(tab, point(args, 'Click'), args.snapshot_id);
      return p ? act.clickAt(tab, p, args) : act.click(tab, args.id!, args);
    }),
);

server.registerTool(
  'hover',
  {
    title: 'Hover',
    description: 'Moves the pointer onto the element, or to a point of the view (x, y), and leaves it there; answers with what appeared (a menu, a tooltip).',
    inputSchema: {
      id: id.optional(),
      x: px('A point to move to instead of an element').optional(),
      y: px('Its y').optional(),
      snapshot_id: snapshotId,
    },
  },
  (args) =>
    guard(async () => {
      const tab = await current().tab();
      const p = inView(tab, point(args, 'Hover'), args.snapshot_id);
      return p ? act.hoverAt(tab, p) : act.hover(tab, args.id!);
    }),
);

server.registerTool(
  'type',
  {
    title: 'Type',
    description:
      'Types text at a human pace (about 6 characters a second), clicking into the element first when an id is given. Rare typos are made and corrected at once, as a person would, except in fields where a wrong character matters (passwords, numbers, codes, card fields); exact: true turns them off. Or plays a scripted burst (keys): text, Backspaces, pauses and key presses in order, with no typos of its own. A newline in text is Enter, a tab character Tab.',
    inputSchema: inputOf({
      id: id.optional(),
      text: z
        .string()
        .optional()
        .describe(
          REPLAY
            ? 'What to type; with keys, what the burst must leave, checked before anything is sent: a plain Enter, Tab or Space press counts as the character it types and a plain Backspace as one bs; a burst that also presses keys whose effect the check cannot follow (arrows, Delete, Ctrl+A, Ctrl+V, Ctrl+Z...) is refused.'
            : 'What to type. Give text or keys, not both.',
        ),
      keys: z
        .array(
          z.union([
            z.string(),
            z.object({ bs: z.number().int().min(1).max(500) }).strict(),
            z.object({ pause_ms: z.number().int().min(0).max(600_000) }).strict(),
            z.object({ press: z.string() }).strict(),
          ]),
        )
        .optional()
        .describe('A burst: strings to type, {"bs": n} for n Backspaces, {"pause_ms": n} to stop for n ms, {"press": "Ctrl+I"} for a key or shortcut (a formatting toggle; its key is a named key or one ASCII character). Every press is checked before anything is sent; a step that fails stops the burst, and the answer counts what went out before it.'),
      clear: z.boolean().optional().describe('Select what the field holds first, so the text replaces it.'),
      submit: z.boolean().optional().describe('Press Enter after.'),
      exact: z.boolean().optional().describe('No typos at all.'),
      ...replayOnly({
        seed: z
          .number()
          .int()
          .min(0)
          .max(2 ** 47)
          .optional()
          .describe("The same seed, text and pace give the same rhythm of the typed strings (and the same gaps between a burst's steps). It does not fix the timing of key presses and Backspaces, which the browser times afresh each call."),
      }),
      speed: z
        .number()
        .min(0.25)
        .max(3)
        .optional()
        .describe("Pace against this browser's typist: 2 is twice as fast, 0.5 half (default 1). The browser stops at about 110 words a minute, whatever the speed."),
      ...replayOnly({ not_before: notBefore }),
      expect_focus: expectFocus,
      quiet,
    }),
  },
  (args, extra) =>
    guard(async () => {
      refuseReplay(args, ['not_before', 'seed']);
      if (!REPLAY && args.text !== undefined && args.keys) {
        throw new ToolError(`Nothing was typed: give text or keys, not both. Checking a burst against the text it must leave needs ${SETTING} turned on.`);
      }
      return act.type(await current().tab(), {
        ...args,
        notBefore: act.parseNotBefore(args.not_before),
        expectFocus: args.expect_focus,
        signal: extra.signal,
      });
    }),
);

server.registerTool(
  'press',
  {
    title: 'Press keys',
    description: 'Presses a key or a chord: Enter, Escape, Tab, ArrowDown, Ctrl+A, Shift+Tab, Ctrl+Shift+Left, F5. The key is a named key or one ASCII character; type other characters with type. With times, again and again as a person does.',
    inputSchema: inputOf({
      keys: z.string(),
      times: z.number().int().min(1).max(50).optional(),
      ...replayOnly({ not_before: notBefore }),
      expect_focus: expectFocus,
      quiet,
    }),
  },
  (args, extra) =>
    guard(async () => {
      refuseReplay(args, ['not_before']);
      return act.press(await current().tab(), args.keys, args.times, {
        notBefore: act.parseNotBefore(args.not_before),
        expectFocus: args.expect_focus,
        quiet: args.quiet,
        signal: extra.signal,
      });
    }),
);

server.registerTool(
  'scroll',
  {
    title: 'Scroll',
    description:
      'Turns the mouse wheel like a person, over an element when one is given (the pointer moves there first), else where the pointer is.',
    inputSchema: {
      direction: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().int().min(1).max(100000).optional().describe('CSS pixels (default 400).'),
      id: id.optional(),
      pace: z.enum(['read', 'flick']).optional().describe('read (default) or flick for a long jump.'),
      quiet,
    },
  },
  (args) => guard(async () => act.scroll(await current().tab(), args)),
);

server.registerTool(
  'dialog',
  {
    title: 'Answer a dialog',
    description: 'Accepts or dismisses the alert, confirm, prompt or leave-page dialog open on the selected tab.',
    inputSchema: { accept: z.boolean(), text: z.string().optional().describe("A prompt dialog's answer.") },
  },
  (args) => guard(async () => act.answerDialog(await current().tab(), args.accept, args.text)),
);

server.registerTool(
  'screenshot',
  {
    title: 'Save a screenshot',
    description: 'Saves a PNG of the view (or the whole page) to a file and answers with its path; shows you nothing.',
    inputSchema: {
      path: z.string().optional().describe('Where to save it (default: screenshots/ under the working folder).'),
      full_page: z.boolean().optional(),
    },
  },
  (args) => guard(async () => act.screenshot(await current().tab(), args.path, args.full_page)),
);

server.registerTool(
  'eval_js',
  {
    title: 'Run JavaScript',
    description:
      "Evaluates an expression in the page's main world and answers with its value as JSON (promises are awaited). For reading app state or the DOM; prefer click and type for input, which pages see as real.",
    inputSchema: { expression: z.string() },
  },
  (args) =>
    guard(async () => {
      const r = await act.evaluate(await current().tab(), args.expression);
      return text(r.text, r.isError);
    }),
);

server.registerTool(
  'select',
  {
    title: 'Pick in a dropdown',
    description:
      'Picks options in a <select> the way a person does (opens its list and clicks, or uses the keys when the list cannot open). values: one for a dropdown, the exact set for a multiple list; each matches an option by its visible text or its value. A wrong value is refused with the options there are.',
    inputSchema: { id, values: z.array(z.string()).min(1) },
  },
  (args) => guard(async () => act.select(await current().tab(), args.id, args.values)),
);

server.registerTool(
  'fill_date',
  {
    title: 'Fill a date or time field',
    description:
      'Fills an input of type date, time, datetime-local, month or week part by part, as typed by a person. value as the field\'s value attribute takes it: 2024-05-03, 14:30, 2024-05-03T14:30, 2024-05, 2024-W18.',
    inputSchema: { id, value: z.string() },
  },
  (args) => guard(async () => act.fillDate(await current().tab(), args.id, args.value)),
);

server.registerTool(
  'pick_color',
  {
    title: 'Pick a colour',
    description: 'Sets an input of type color through its own picker. value as #rrggbb.',
    inputSchema: { id, value: z.string().regex(/^#[0-9a-fA-F]{6}$/) },
  },
  (args) => guard(async () => act.pickColor(await current().tab(), args.id, args.value)),
);

server.registerTool(
  'upload',
  {
    title: 'Choose files',
    description:
      'Clicks a file field (or the button or label that opens one) and answers its file chooser with these files, as a person picking them would. Paths are on this machine; relative ones are from the working folder. For a folder field, one folder.',
    inputSchema: { id, files: z.array(z.string()).min(1) },
  },
  (args) => guard(async () => act.upload(await current().tab(), args.id, args.files)),
);

server.registerTool(
  'drag',
  {
    title: 'Drag',
    description:
      'Drags an element with a real pointer: presses, carries (scrolling under itself where needed) and lets go. Drop onto another element (to, with slot before/after/on for sortable lists), onto a point of the view (x, y), or set a slider (value). Works for native drag and drop and for pointer-driven libraries. Or drags from a point (from_x, from_y) to a point or an element, as a person selects text: press between two characters, let go between two others. The answer says what kind of drag the page made of it: a pointer drag selects; a native drag means the press landed on something the page drags (in an editor, text already selected), and that was dragged instead. A drag cannot start at a point inside a frame of another site.',
    inputSchema: {
      from: id.optional(),
      from_x: px('A point to press at instead of an element').optional(),
      from_y: px('Its y').optional(),
      to: id.optional(),
      slot: z.enum(['on', 'before', 'after']).optional(),
      x: px('A point to let go at').optional(),
      y: px('Its y').optional(),
      snapshot_id: snapshotId,
      value: z.number().optional().describe("A range input's value to set."),
      modifiers: z.array(z.enum(['Alt', 'Ctrl', 'Meta', 'Shift'])).optional().describe('Keys held through a drag from a point.'),
      quiet,
    },
  },
  (args) =>
    guard(async () => {
      const tab = await current().tab();
      if (!args.snapshot_id) return act.drag(tab, args);
      const from = args.from_x !== undefined && args.from_y !== undefined ? { x: args.from_x, y: args.from_y } : null;
      const to = args.x !== undefined && args.y !== undefined ? { x: args.x, y: args.y } : null;
      if (!from && !to) throw new ToolError('snapshot_id is for points (from_x and from_y, or x and y) read off its image.');
      const [f, t] = act.pointsOfImage(tab, args.snapshot_id, [from, to]);
      return act.drag(tab, { ...args, ...(f ? { from_x: f.x, from_y: f.y } : {}), ...(t ? { x: t.x, y: t.y } : {}) });
    }),
);

server.registerTool(
  'paste',
  {
    title: 'Paste',
    description:
      "Pastes text with Ctrl+V from the browser's own clipboard (the machine's clipboard is never touched), clicking into the element first when an id is given. Faster than type for long text; the page sees a real paste of plain text, which an editor such as Google Docs gives the formatting at the caret.",
    inputSchema: inputOf({ text: z.string(), id: id.optional(), ...replayOnly({ not_before: notBefore }), expect_focus: expectFocus, quiet }),
  },
  (args, extra) =>
    guard(async () => {
      refuseReplay(args, ['not_before']);
      return act.paste(await current().tab(), args.text, args.id, {
        notBefore: act.parseNotBefore(args.not_before),
        expectFocus: args.expect_focus,
        quiet: args.quiet,
        signal: extra.signal,
      });
    }),
);

server.registerTool(
  'fetch',
  {
    title: 'Read a URL',
    description:
      "Reads a URL through the browser, with its cookies, fingerprint and network, in a hidden page that never becomes a tab: HTML is rendered and returned as Markdown, anything else as text. A method, headers or a body make it an API call from a page of the URL's origin. Says when a bot challenge or a block got in the way. Needs an open browser (headless is fine).",
    inputSchema: {
      url: z.string(),
      mode: z.enum(['auto', 'raw']).optional().describe('raw: the response as it is, even HTML.'),
      method: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      links: z.boolean().optional().describe('Also list every link on the page.'),
      max_chars: z
        .number()
        .int()
        .min(1_000)
        .max(200_000)
        .optional()
        .describe('How much of the text to return (default 40,000); the rest is saved to a file.'),
      save_to: z
        .string()
        .optional()
        .describe("A new file to save the body in (a download, such as a Google Docs export: /export?format=docx); without it a binary body goes to a file under the profile. A text body is saved as the response's text; an HTML page as the Markdown it is rendered to, unless mode is raw. A file that already exists, or a folder that cannot be made, is refused before the request goes out. A failure to write afterwards is said in the answer, which still carries the response."),
    },
    annotations: { readOnlyHint: true },
    _meta: { 'anthropic/maxResultSizeChars': 250_000 },
  },
  (args) => guard(async () => whole.fetchUrl(current(), args)),
);

server.registerTool(
  'record_start',
  {
    title: 'Record traffic',
    description:
      "Records every request, response and websocket message of the whole browser, from inside the browser (pages cannot see it): a HAR with bodies, a grep-able request list, and a summary. full also keeps every script the pages compiled. The files hold cookies and whatever the pages sent: keep them out of version control.",
    inputSchema: {
      level: z.enum(['network', 'full']).optional(),
      path: z.string().optional().describe('A folder for the files (default: recordings/ under the working folder).'),
      minutes: z.number().int().min(1).max(120).optional().describe('It ends by itself after this (default 15).'),
    },
  },
  (args) => guard(async () => whole.recordStart(current(), args)),
);

server.registerTool(
  'record_stop',
  { title: 'Stop recording', description: "Ends the recording, closes its files and answers with its summary.", inputSchema: {} },
  () => guard(async () => whole.recordStop(current())),
);

server.registerTool(
  'fingerprint',
  {
    title: 'Fingerprint report',
    description:
      'What this browser shows sites about the machine: user agent, GPU, hardware, screen, time zone, languages, fonts, WebRTC, as set for this launch. full: every field as JSON.',
    inputSchema: { full: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  },
  (args) => guard(async () => whole.fingerprint(current(), args.full)),
);

// Claude Code ends a session by closing stdin; the browser then closes itself
// once this process is gone. Stopping a recording first keeps its files whole,
// and Browser.close makes the close quicker.
process.stdin.on('end', () => {
  if (browser && !browser.closed) {
    const b = browser;
    const stop = b.recordingId
      ? b.conn.send('Browser.stopRecording', { recordingId: b.recordingId }, undefined, 2_000).catch(() => {})
      : Promise.resolve();
    void stop.then(() => b.conn.send('Browser.close').catch(() => {}));
  }
  setTimeout(() => process.exit(0), 250);
});

// What the plugin kept under its name before 0.2.0 (paths.ts): renames
// only, so quick, and done before the first tool call can launch from the old
// place. A failure leaves things as they are and must not keep the server
// from starting.
try {
  moveFromChromeleon();
  sweepPageCounts();
} catch {
  // A later start tries again.
}
await server.connect(new StdioServerTransport());
// Replaced releases left to delete: seconds of work, after the handshake.
removePendingReleases().catch(() => {});
