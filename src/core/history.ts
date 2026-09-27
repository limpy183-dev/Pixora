// Undo/redo history.
//
// Two ways to record a change:
//   1. doc.history.transaction('Name', () => { ...mutate layers/selection/doc props... })
//      Captures a structural snapshot of the whole document before/after (layer props + canvas REFERENCES).
//      Inside, replace canvases instead of mutating them (layer.canvas = newCanvas).
//   2. const edit = doc.history.beginPixelEdit(canvasHolder) ... mutate canvas in place ... edit.commit('Brush Tool', rect)
//      For local in-place painting. `rect` is in the CANVAS's own pixel coordinates (omit to auto-detect by diff).
// Transactions nest: pushes made inside a transaction are folded into it.
import { events } from './events';
import { createCanvas, ctx2d, cropCanvas } from './canvas';
import type { PixDocument, DocState } from './document';
import type { Rect } from './types';
import { intersectRect } from './geom';

export interface HistoryEntry {
  name: string;
  icon?: string;
  undo(): void;
  redo(): void;
}

export interface HistorySnapshot { name: string; state: DocState }

/** Anything that owns a canvas which can be swapped (layer pixels, mask, quick mask...). */
export interface CanvasHolder { canvas: HTMLCanvasElement }

export class PixelEdit {
  private backup: HTMLCanvasElement | null;
  readonly canvas: HTMLCanvasElement;
  constructor(private history: History, holder: CanvasHolder, readonly name?: string, readonly icon?: string) {
    this.canvas = holder.canvas;
    this.backup = createCanvas(this.canvas.width, this.canvas.height);
    ctx2d(this.backup).drawImage(this.canvas, 0, 0);
  }
  /** The untouched pixels captured at begin (read-only). */
  get original(): HTMLCanvasElement { return this.backup!; }
  /** Record the change. `rect` is in canvas pixel coords; omitted → computed by diffing. Returns false if nothing changed. */
  commit(name = this.name || 'Edit', rect?: Rect | null, icon = this.icon): boolean {
    if (!this.backup) return false;
    const full = { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height };
    let r = rect ? intersectRect({ x: Math.floor(rect.x), y: Math.floor(rect.y), w: Math.ceil(rect.w + rect.x - Math.floor(rect.x)), h: Math.ceil(rect.h + rect.y - Math.floor(rect.y)) }, full) : diffRect(this.backup, this.canvas);
    if (!r) { this.backup = null; return false; }
    const before = cropCanvas(this.backup, r), after = cropCanvas(this.canvas, r), canvas = this.canvas, rr = r;
    this.backup = null;
    const put = (src: HTMLCanvasElement) => {
      const x = ctx2d(canvas);
      x.save(); x.globalCompositeOperation = 'copy'; x.globalAlpha = 1; x.filter = 'none';
      x.beginPath(); x.rect(rr.x, rr.y, rr.w, rr.h); x.clip();
      x.drawImage(src, rr.x, rr.y);
      x.restore();
    };
    this.history.push({ name, icon, undo: () => put(before), redo: () => put(after) });
    return true;
  }
  /** Abort: restore the original pixels. */
  cancel() {
    if (!this.backup) return;
    const x = ctx2d(this.canvas);
    x.save(); x.globalCompositeOperation = 'copy'; x.globalAlpha = 1; x.drawImage(this.backup, 0, 0); x.restore();
    this.backup = null;
  }
}

/** Bounding rect of differing pixels between two same-size canvases. */
export function diffRect(a: HTMLCanvasElement, b: HTMLCanvasElement): Rect | null {
  const w = a.width, h = a.height;
  if (w !== b.width || h !== b.height) return { x: 0, y: 0, w: Math.max(w, b.width), h: Math.max(h, b.height) };
  const da = new Uint32Array(ctx2d(a).getImageData(0, 0, w, h).data.buffer);
  const db = new Uint32Array(ctx2d(b).getImageData(0, 0, w, h).data.buffer);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      if (da[o + x] !== db[o + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export class History {
  entries: HistoryEntry[] = [];
  /** Number of applied entries (entries[0..index-1] are applied). */
  index = 0;
  /** Name/icon of the base state shown first in the History panel ("New", "Open"). */
  baseName = 'New';
  /** Full-copy snapshots shown at the top of the History panel. snapshots[0] is the document's initial state. */
  snapshots: HistorySnapshot[] = [];
  limit = 50;
  private depth = 0;
  private collected: HistoryEntry[] = [];
  private busy = false;

  constructor(private doc: PixDocument) {}

  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.entries.length; }
  get inTransaction() { return this.depth > 0; }

  push(entry: HistoryEntry) {
    if (this.busy) return;
    if (this.depth > 0) { this.collected.push(entry); return; }
    this.entries.length = this.index;
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.index = this.entries.length;
    this.doc.modified = true;
    events.emit('history', this.doc);
  }

  /** Run `fn` and record everything it changes as one history state. Returns fn's result. */
  transaction<T>(name: string, fn: () => T, icon?: string): T {
    if (this.depth > 0 || this.busy) return fn();
    const doc = this.doc;
    const before = doc.captureState();
    this.depth++;
    this.collected = [];
    let result: T;
    try {
      result = fn();
    } catch (err) {
      const subs = this.collected;
      this.depth--; this.collected = [];
      this.busy = true;
      try { for (let i = subs.length - 1; i >= 0; i--) subs[i].undo(); doc.restoreState(before); } finally { this.busy = false; }
      throw err;
    }
    this.depth--;
    const subs = this.collected;
    this.collected = [];
    const after = doc.captureState();
    this.push({
      name, icon,
      undo: () => { for (let i = subs.length - 1; i >= 0; i--) subs[i].undo(); doc.restoreState(before); },
      redo: () => { doc.restoreState(before); for (const s of subs) s.redo(); doc.restoreState(after); },
    });
    return result;
  }

  /** Async variant of transaction (for dialogs/file ops). */
  async transactionAsync<T>(name: string, fn: () => Promise<T>, icon?: string): Promise<T> {
    if (this.depth > 0) return fn();
    const doc = this.doc, before = doc.captureState();
    this.depth++; this.collected = [];
    try {
      const result = await fn();
      this.depth--;
      const subs = this.collected; this.collected = [];
      const after = doc.captureState();
      this.push({
        name, icon,
        undo: () => { for (let i = subs.length - 1; i >= 0; i--) subs[i].undo(); doc.restoreState(before); },
        redo: () => { doc.restoreState(before); for (const s of subs) s.redo(); doc.restoreState(after); },
      });
      return result;
    } catch (err) {
      this.depth--;
      const subs = this.collected; this.collected = [];
      for (let i = subs.length - 1; i >= 0; i--) subs[i].undo();
      doc.restoreState(before);
      throw err;
    }
  }

  /**
   * Interactive edit (drags, live dialogs): captures the state now; mutate freely (replace canvases, change props),
   * then commit() to record one history state or cancel() to restore.
   */
  begin(name: string, icon?: string): { commit(name?: string): void; cancel(): void; readonly before: DocState } {
    const doc = this.doc, before = doc.captureState();
    let done = false;
    return {
      before,
      commit: (n = name) => {
        if (done) return; done = true;
        const after = doc.captureState();
        this.push({ name: n, icon, undo: () => doc.restoreState(before), redo: () => doc.restoreState(after) });
      },
      cancel: () => { if (done) return; done = true; doc.restoreState(before); },
    };
  }

  beginPixelEdit(holder: CanvasHolder, name?: string, icon?: string): PixelEdit {
    return new PixelEdit(this, holder, name, icon);
  }

  undo() { if (this.canUndo) this.goTo(this.index - 1); }
  redo() { if (this.canRedo) this.goTo(this.index + 1); }

  /** Move to a history position (0 = base state). */
  goTo(n: number) {
    n = Math.max(0, Math.min(this.entries.length, n));
    if (n === this.index) return;
    this.busy = true;
    try {
      while (this.index > n) this.entries[--this.index].undo();
      while (this.index < n) this.entries[this.index++].redo();
    } finally { this.busy = false; }
    this.doc.afterHistoryJump();
    events.emit('history', this.doc);
  }

  /** Save a full-copy snapshot of the current document state. */
  snapshot(name?: string) {
    this.snapshots.push({ name: name || `Snapshot ${this.snapshots.length}`, state: this.doc.captureState(true) });
    events.emit('history', this.doc);
  }
  /** Revert the document to a snapshot (recorded as a new history state). */
  revertToSnapshot(i: number) {
    const s = this.snapshots[i];
    if (!s) return;
    this.transaction(s.name, () => this.doc.restoreState(s.state, true));
  }
  clear() { this.entries = []; this.index = 0; events.emit('history', this.doc); }
}
