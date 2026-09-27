// Minimal DOM helpers.
type Attrs = Record<string, any> | null | undefined;
type Child = Node | string | number | null | undefined | false | Child[];

/** h('div.cls#id', {onclick, style, ...}, ...children) */
export function h<K extends keyof HTMLElementTagNameMap>(sel: K, attrs?: Attrs, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(sel: string, attrs?: Attrs, ...children: Child[]): HTMLElement;
export function h(sel: string, attrs?: Attrs, ...children: Child[]): HTMLElement {
  const m = sel.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const tag = (m && m[1]) || 'div';
  const el = document.createElement(tag) as any;
  if (m && m[2]) for (const part of m[2].match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class' || k === 'className') { for (const c of String(v).split(/\s+/)) if (c) el.classList.add(c); }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}
function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}
export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];
export function clear(el: Element) { while (el.firstChild) el.removeChild(el.firstChild); }

/** Drag helper: calls move(dx, dy, e) with deltas from the start point until pointerup. */
export function dragPointer(e: PointerEvent, move: (dx: number, dy: number, ev: PointerEvent) => void, up?: (ev: PointerEvent) => void) {
  const sx = e.clientX, sy = e.clientY, target = e.target as Element;
  try { target.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
  const mv = (ev: PointerEvent) => move(ev.clientX - sx, ev.clientY - sy, ev);
  const u = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', u);
    window.removeEventListener('pointercancel', u);
    up?.(ev);
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', u);
  window.addEventListener('pointercancel', u);
}

/** Position a floating element next to an anchor rect, keeping it on screen. */
export function placeFloating(el: HTMLElement, anchor: DOMRect | { left: number; top: number; right: number; bottom: number }, side: 'below' | 'right' | 'above' = 'below') {
  el.style.left = '0px'; el.style.top = '0px';
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let x: number, y: number;
  if (side === 'right') { x = anchor.right; y = anchor.top; if (x + r.width > vw) x = anchor.left - r.width; }
  else if (side === 'above') { x = anchor.left; y = anchor.top - r.height; }
  else { x = anchor.left; y = anchor.bottom; if (y + r.height > vh) y = Math.max(4, anchor.top - r.height); }
  x = Math.max(2, Math.min(x, vw - r.width - 2));
  y = Math.max(2, Math.min(y, vh - r.height - 2));
  el.style.left = x + 'px'; el.style.top = y + 'px';
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t = 0;
  return ((...a: any[]) => { clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); }) as T;
}
export function throttleFrame<T extends (...a: any[]) => void>(fn: T): T {
  let queued = false, args: any[] = [];
  return ((...a: any[]) => { args = a; if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(...args); }); }) as T;
}
/** Is keyboard focus in a text field (shortcuts should be ignored)? */
export function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !['checkbox', 'radio', 'range', 'button', 'color'].includes((el as HTMLInputElement).type);
  return el.tagName === 'SELECT';
}
