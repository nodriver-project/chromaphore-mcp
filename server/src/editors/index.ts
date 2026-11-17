// Editor modules: what an editor that draws its own text (Google Docs) shows
// of its caret and selection, as text. Each module knows its editor by the
// page's signature, not its address, and nothing of it is in the general
// tools: the listing code only asks whether a module knows the page and what
// it says (docs/DESIGN.md, "Editor modules").
import type { CanvasRead, Line } from '../canvas.js';
import { docs } from './docs.js';

// What a module is given: the canvas read the listing made (Page.agentCanvasText
// with inView), its lines, and one way to run a script in an isolated world
// of the tab's main document, which the page cannot see.
export interface EditorPage {
  read: CanvasRead;
  lines: Line[];
  evaluate: (expression: string) => Promise<any>;
}

export interface Editor {
  name: string;
  // The lines to add, or null when the page is not this editor's.
  describe(page: EditorPage): Promise<string[] | null>;
}

const EDITORS: Editor[] = [docs];

// The lines of the first module that knows the page, or null when none does.
// Only a page whose canvas read holds a 2D canvas is asked about, so other
// pages cost nothing.
export async function editorLines(page: EditorPage): Promise<string[] | null> {
  if (!page.read.canvases.some((c) => c.context === '2d')) return null;
  for (const e of EDITORS) {
    const said = await e.describe(page);
    if (said) return said;
  }
  return null;
}
