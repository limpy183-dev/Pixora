// Browser file I/O: open pickers, save (File System Access API with remembered handles when available, otherwise a
// download), per-document save targets, and the Open Recent list (file contents kept in IndexedDB so entries can be
// reopened after a reload).
import type { PixDocument } from '../../core/document';
import { app } from '../../core/app';
import { h } from '../../ui/dom';
import { FORMAT_INFO, type SaveFormat } from './formats';

// ------------------------------------------------------------------ open
export function pickFiles(accept: string, multiple = false, capture = false): Promise<File[]> {
  return new Promise(resolve => {
    const inp = h('input', { type: 'file', accept, multiple }) as HTMLInputElement;
    if (capture) inp.setAttribute('capture', 'environment');
    inp.style.display = 'none';
    document.body.append(inp);
    let done = false;
    const finish = (files: File[]) => { if (done) return; done = true; inp.remove(); resolve(files); };
    inp.addEventListener('change', () => finish(Array.from(inp.files || [])));
    inp.addEventListener('cancel', () => finish([]));
    inp.click();
  });
}

// ------------------------------------------------------------------ save targets
export interface SaveTarget { name: string; format: SaveFormat; handle?: any }
const targets = new WeakMap<PixDocument, SaveTarget>();
export const saveTargetOf = (doc: PixDocument) => targets.get(doc) || null;
export const setSaveTarget = (doc: PixDocument, t: SaveTarget | null) => { if (t) targets.set(doc, t); else targets.delete(doc); };

const hasFSA = () => typeof (window as any).showSaveFilePicker === 'function' && window.isSecureContext;

/** Ask for a destination (native dialog when supported). Returns null on cancel; `handle` undefined = download. */
export async function chooseSaveTarget(suggested: string, formats: SaveFormat[]): Promise<SaveTarget | null> {
  const ext = /\.([^.]+)$/.exec(suggested)?.[1]?.toLowerCase();
  const first = formats.find(f => FORMAT_INFO[f].ext === ext || (f === 'jpeg' && ext === 'jpeg')) || formats[0];
  if (hasFSA()) {
    try {
      const types = [first, ...formats.filter(f => f !== first)].map(f => ({ description: FORMAT_INFO[f].label, accept: { [FORMAT_INFO[f].mime]: ['.' + FORMAT_INFO[f].ext] } }));
      const handle = await (window as any).showSaveFilePicker({ suggestedName: suggested, types, excludeAcceptAllOption: false });
      const name: string = handle.name;
      const e = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
      const format = formats.find(f => FORMAT_INFO[f].ext === e || (f === 'jpeg' && (e === 'jpeg' || e === 'jpe'))) || first;
      return { name, format, handle };
    } catch (err: any) {
      if (err?.name === 'AbortError') return null;
      // fall through to download (e.g. blocked in iframes)
    }
  }
  return { name: suggested, format: first };
}

/** Write a blob to a target (handle) or download it. */
export async function writeTarget(t: SaveTarget, blob: Blob): Promise<void> {
  if (t.handle) {
    const w = await t.handle.createWritable();
    await w.write(blob);
    await w.close();
    return;
  }
  downloadBlob(blob, t.name);
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ------------------------------------------------------------------ recent files (IndexedDB)
export interface RecentEntry { id: string; name: string; date: number; size: number; type: string }
const DB = 'pixora-files', STORE = 'recent';
function openDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB();
  return new Promise<T>((res, rej) => {
    const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
let recentCache: RecentEntry[] = (() => { try { return JSON.parse(localStorage.getItem('pixora.recent') || '[]'); } catch { return []; } })();
const saveRecentList = () => { try { localStorage.setItem('pixora.recent', JSON.stringify(recentCache)); } catch { /* ignore */ } };
export const recentList = () => recentCache;

const MAX_BYTES = 80 * 1024 * 1024;
export async function addRecent(name: string, blob: Blob) {
  const id = name.toLowerCase();
  recentCache = [{ id, name, date: Date.now(), size: blob.size, type: blob.type }, ...recentCache.filter(r => r.id !== id)];
  const max = Math.max(0, app.prefs.recentFileCount | 0);
  const dropped = recentCache.slice(max);
  recentCache = recentCache.slice(0, max);
  saveRecentList();
  try {
    if (blob.size <= MAX_BYTES) await tx('readwrite', s => s.put({ id, name, blob }));
    for (const d of dropped) await tx('readwrite', s => s.delete(d.id));
  } catch { /* storage unavailable: the list still shows names */ }
}
export async function getRecent(id: string): Promise<{ name: string; blob: Blob } | null> {
  try { return (await tx<any>('readonly', s => s.get(id))) || null; } catch { return null; }
}
export async function clearRecent() {
  recentCache = []; saveRecentList();
  try { await tx('readwrite', s => s.clear()); } catch { /* ignore */ }
}
