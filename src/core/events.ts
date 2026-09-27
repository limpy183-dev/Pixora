// Tiny typed event bus.
import type { PixDocument } from './document';
import type { Layer } from './layer';
import type { Rect } from './types';

export interface AppEvents {
  docs: void;                                    // documents opened/closed/renamed
  activeDoc: PixDocument | null;                 // active document switched
  layers: PixDocument;                           // layer tree / layer props changed
  activeLayer: PixDocument;                      // active / selected layers changed
  pixels: { doc: PixDocument; layer: Layer | null; rect: Rect | null }; // content changed (throttle heavy listeners)
  selection: PixDocument;                        // selection changed
  history: PixDocument;                          // history stack changed
  view: PixDocument;                             // zoom / pan / rotation changed
  docSize: PixDocument;                          // canvas size / resolution / mode changed
  colors: void;                                  // foreground / background changed
  tool: void;                                    // active tool changed
  toolOptions: void;                             // active tool settings changed
  guides: PixDocument;                           // guides changed
  paths: PixDocument;                            // paths (Paths panel) changed
  prefs: void;                                   // preferences changed
  panels: void;                                  // dock layout changed
  render: PixDocument;                           // a frame was rendered (for overlays like Navigator)
  status: string;                                // transient status message
  command: { id: string; arg?: any };            // a command is about to run (Actions recording)
  theme: void;                                   // UI theme changed
}

type Handler<T> = (payload: T) => void;

export class Emitter<E extends Record<string, any>> {
  private map = new Map<keyof E, Set<Handler<any>>>();
  on<K extends keyof E>(type: K, fn: Handler<E[K]>): () => void {
    let set = this.map.get(type);
    if (!set) this.map.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }
  emit<K extends keyof E>(type: K, payload?: E[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload as E[K]); } catch (err) { console.error(`[event ${String(type)}]`, err); }
    }
  }
}

export const events = new Emitter<AppEvents>();
