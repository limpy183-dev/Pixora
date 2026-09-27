// Global application state: open documents, colors, tools, preferences.
import { events } from './events';
import type { PixDocument } from './document';
import type { RGB } from './types';
import type { Viewport } from './viewport';

// ---------------------------------------------------------------- tools
export interface ToolPointer {
  x: number; y: number;          // document coordinates (float)
  sx: number; sy: number;        // screen coordinates relative to the canvas area (CSS px)
  pressure: number;              // 0..1 (mouse = 1)
  tiltX: number; tiltY: number;
  button: number; buttons: number;
  shift: boolean; alt: boolean; ctrl: boolean;  // ctrl = Ctrl or Cmd
  pointerType: string;
  time: number;
  event: PointerEvent | MouseEvent;
}

export interface Tool {
  id: string;                    // unique, e.g. 'brush'
  name: string;                  // 'Brush Tool'
  /** Toolbar slot id (see TOOLBAR_LAYOUT in ui/toolbar.ts), e.g. 'brush'. */
  group: string;
  icon: string;                  // icon name (ui/icons.ts)
  shortcut?: string;             // single letter, e.g. 'B' (Shift+letter cycles the group)
  order?: number;                // order inside the flyout (lower first; lowest is the default)
  /** CSS cursor for the canvas, or a function (called on hover/modifier change). */
  cursor?: string | ((doc: PixDocument | null) => string);
  /** Persisted tool settings (saved to localStorage automatically). */
  settings?: Record<string, any>;
  /** Build the options bar contents. Return a cleanup fn if needed. */
  options?(bar: HTMLElement): void | (() => void);
  activate?(): void;
  deactivate?(): void;
  pointerDown?(p: ToolPointer, doc: PixDocument): void;
  pointerMove?(p: ToolPointer, doc: PixDocument): void;   // while a button is pressed (coalesced events)
  pointerUp?(p: ToolPointer, doc: PixDocument): void;
  hover?(p: ToolPointer, doc: PixDocument): void;         // pointer moves with no buttons
  dblclick?(p: ToolPointer, doc: PixDocument): void;
  /** Return true if the key was handled (prevents global shortcuts). */
  keyDown?(e: KeyboardEvent, doc: PixDocument | null): boolean | void;
  keyUp?(e: KeyboardEvent, doc: PixDocument | null): boolean | void;
  /** Draw tool feedback on the overlay canvas. ctx is in SCREEN space (CSS px); use view.docToScreen(). */
  drawOverlay?(ctx: CanvasRenderingContext2D, view: Viewport, doc: PixDocument): void;
  /** Modal tools (crop, transform, text edit): Enter → commit(), Esc → cancel(). */
  isModal?(): boolean;
  commit?(): void;
  cancel?(): void;
  /** true = this tool paints (brush cursor, [ ] size shortcuts via settings.size / settings.hardness). */
  paints?: boolean;
  /** Holding Alt temporarily switches to the Eyedropper (Brush, Pencil, Gradient, Paint Bucket...). */
  altEyedropper?: boolean;
  /** Don't switch to the Move tool while Ctrl is held. */
  noCtrlMove?: boolean;
  /** Canvas context menu (right click). */
  contextMenu?(p: ToolPointer, doc: PixDocument): void;
  /** Ignore pointer events when there is no document (default: ignore). */
  worksWithoutDoc?: boolean;
}

// ---------------------------------------------------------------- preferences
export type Theme = 'darkest' | 'dark' | 'medium' | 'light';
export interface Prefs {
  theme: Theme;
  historyStates: number;
  rulerUnits: 'px' | 'in' | 'cm' | 'mm' | 'pt' | '%';
  typeUnits: 'pt' | 'px' | 'mm';
  gridSpacing: number;          // in px
  gridSubdivisions: number;
  gridColor: string;
  guideColor: string;
  smartGuideColor: string;
  zoomWithScroll: boolean;
  animatedZoom: boolean;
  showTooltips: boolean;
  uiFontSize: 'small' | 'medium' | 'large';
  showTransformValues: boolean;
  checkerSize: number;
  paintingCursor: 'standard' | 'precise' | 'normal-tip' | 'full-tip';
  autoSelectDefault: boolean;
  recentFileCount: number;
}
const DEFAULT_PREFS: Prefs = {
  theme: 'dark', historyStates: 50, rulerUnits: 'px', typeUnits: 'pt',
  gridSpacing: 100, gridSubdivisions: 4, gridColor: '#9e9e9e', guideColor: '#4affff', smartGuideColor: '#ff4aff',
  zoomWithScroll: false, animatedZoom: true, showTooltips: true, uiFontSize: 'small', showTransformValues: true,
  checkerSize: 8, paintingCursor: 'normal-tip', autoSelectDefault: false, recentFileCount: 20,
};

function loadJSON<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? { ...fallback, ...JSON.parse(v) } : fallback; } catch { return fallback; }
}
export function saveJSON(key: string, v: any) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }

class App {
  docs: PixDocument[] = [];
  activeDoc: PixDocument | null = null;
  fg: RGB = { r: 255, g: 255, b: 255 };
  bg: RGB = { r: 35, g: 19, b: 62 };
  tools = new Map<string, Tool>();
  activeTool: Tool | null = null;
  /** Last used tool per toolbar group. */
  groupSelection: Record<string, string> = loadJSON('pixora.toolGroups', {});
  prefs: Prefs = loadJSON('pixora.prefs', DEFAULT_PREFS);
  /** 'standard' | 'full-menu' | 'full' (F key). */
  screenMode: 'standard' | 'full-menu' | 'full' = 'standard';
  /** Toggled by Tab: hides toolbar/options/panels. */
  panelsHidden = false;
  /** Temporary tool override (Space → Hand, Alt → Eyedropper, Ctrl → Move). */
  springTool: Tool | null = null;
  /** The spring key was released mid-drag: drop springTool on pointer up. */
  springReleasePending = false;
  /** Active viewport (set by the workspace). */
  viewport: Viewport | null = null;

  // --------------------------------------------------------------- documents
  addDocument(doc: PixDocument, activate = true) {
    this.docs.push(doc);
    doc.history.limit = this.prefs.historyStates;
    events.emit('docs');
    if (activate) this.setActiveDocument(doc);
  }
  setActiveDocument(doc: PixDocument | null) {
    if (this.activeDoc === doc) return;
    this.activeTool?.isModal?.() && this.activeTool.commit?.();
    this.activeDoc = doc;
    events.emit('activeDoc', doc);
  }
  /** Remove a document (no unsaved-changes prompt – use the file.close command for that). */
  removeDocument(doc: PixDocument) {
    const i = this.docs.indexOf(doc);
    if (i < 0) return;
    this.docs.splice(i, 1);
    events.emit('docs');
    if (this.activeDoc === doc) this.setActiveDocument(this.docs[Math.min(i, this.docs.length - 1)] || null);
  }

  // --------------------------------------------------------------- tools
  registerTool(tool: Tool) {
    const key = `pixora.tool.${tool.id}`;
    if (tool.settings) {
      const saved = loadJSON(key, {} as any);
      for (const k of Object.keys(saved)) if (k in tool.settings) tool.settings[k] = saved[k];
    }
    this.tools.set(tool.id, tool);
  }
  /** Persist a tool's settings and notify the options bar. */
  saveToolSettings(tool: Tool | null = this.activeTool) {
    if (tool?.settings) saveJSON(`pixora.tool.${tool.id}`, tool.settings);
    events.emit('toolOptions');
  }
  getTool(id: string) { return this.tools.get(id) || null; }
  setTool(id: string) {
    const t = this.tools.get(id);
    if (!t || t === this.activeTool) return;
    const prev = this.activeTool;
    if (prev?.isModal?.()) prev.commit?.();
    prev?.deactivate?.();
    this.activeTool = t;
    this.groupSelection[t.group] = t.id;
    saveJSON('pixora.toolGroups', this.groupSelection);
    t.activate?.();
    events.emit('tool');
    this.activeDoc?.redrawOverlay();
  }
  /** Tools of a toolbar group sorted by order. */
  toolsInGroup(group: string): Tool[] {
    return [...this.tools.values()].filter(t => t.group === group).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  /** The tool that is currently in effect (spring-loaded override or active). */
  get currentTool(): Tool | null { return this.springTool || this.activeTool; }

  // --------------------------------------------------------------- colors
  setForeground(c: RGB) { this.fg = { r: c.r | 0, g: c.g | 0, b: c.b | 0 }; this.pushRecent(this.fg); events.emit('colors'); }
  setBackground(c: RGB) { this.bg = { r: c.r | 0, g: c.g | 0, b: c.b | 0 }; events.emit('colors'); }
  swapColors() { [this.fg, this.bg] = [this.bg, this.fg]; events.emit('colors'); }
  resetColors() { this.fg = { r: 0, g: 0, b: 0 }; this.bg = { r: 255, g: 255, b: 255 }; events.emit('colors'); }
  recentColors: RGB[] = [];
  private pushRecent(c: RGB) {
    this.recentColors = [c, ...this.recentColors.filter(x => x.r !== c.r || x.g !== c.g || x.b !== c.b)].slice(0, 12);
  }

  // --------------------------------------------------------------- prefs
  setPrefs(p: Partial<Prefs>) {
    Object.assign(this.prefs, p);
    saveJSON('pixora.prefs', this.prefs);
    if (p.theme) { document.documentElement.dataset.theme = p.theme; events.emit('theme'); }
    if (p.historyStates) for (const d of this.docs) d.history.limit = p.historyStates;
    events.emit('prefs');
    this.activeDoc?.invalidate();
  }

  status(msg: string) { events.emit('status', msg); }
}

export const app = new App();
(window as any).pixora = app;   // handy for debugging / tests
