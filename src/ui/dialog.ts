// Modal dialogs (draggable, Photoshop look). Buttons live on the right for "tool" dialogs (layout: 'side').
import { h, dragPointer } from './dom';
import { icon } from './icons';
import { checkbox } from './widgets';

export interface DialogButton {
  label: string;
  primary?: boolean;
  /** Value the dialog resolves with. */
  value?: any;
  /** Return false to keep the dialog open. */
  onClick?: () => boolean | void | Promise<boolean | void>;
}
export interface DialogOptions {
  title: string;
  body: HTMLElement;
  buttons?: DialogButton[];
  /** 'bottom' (default) or 'side' (buttons stacked on the right like Levels / Curves). */
  layout?: 'bottom' | 'side';
  width?: number;
  /** Adds a "Preview" checkbox below the buttons (side layout) and calls onPreview. */
  preview?: { checked: boolean; onChange: (v: boolean) => void };
  /** Extra elements under the buttons (side layout). */
  sideExtras?: HTMLElement[];
  className?: string;
  /** Value to resolve with when closed via Esc / X. Default null. */
  cancelValue?: any;
  onClose?: (value: any) => void;
  /** Close on Esc (default true) */
  escClose?: boolean;
  modal?: boolean;
}
export interface DialogHandle { el: HTMLElement; close(value?: any): void; result: Promise<any> }

let zTop = 1000;
const stack: DialogHandle[] = [];
export const isDialogOpen = () => stack.length > 0;

export function openDialog(o: DialogOptions): DialogHandle {
  let resolve!: (v: any) => void;
  const result = new Promise<any>(r => (resolve = r));
  const overlay = h('div.dialog-overlay', { class: o.modal === false ? 'modeless' : '' });
  const btnBox = h('div.dialog-buttons');
  const win = h('div.dialog', { class: [o.className || '', o.layout === 'side' ? 'side' : ''].join(' '), role: 'dialog', style: o.width ? { width: o.width + 'px' } : undefined },
    h('div.dialog-title', null, h('span', null, o.title), h('button.dialog-x', { type: 'button', title: 'Close' }, icon('close', 14))),
    h('div.dialog-content', null, h('div.dialog-body', null, o.body), btnBox));
  overlay.style.zIndex = String(++zTop);
  overlay.appendChild(win);
  document.body.appendChild(overlay);

  let closed = false;
  const handle: DialogHandle = {
    el: win, result,
    close(value?: any) {
      if (closed) return;
      closed = true;
      overlay.remove();
      stack.splice(stack.indexOf(handle), 1);
      window.removeEventListener('keydown', onKey, true);
      o.onClose?.(value);
      resolve(value);
    },
  };
  stack.push(handle);

  const buttons = o.buttons ?? [{ label: 'OK', primary: true, value: true }, { label: 'Cancel', value: o.cancelValue ?? null }];
  let primaryBtn: HTMLButtonElement | null = null;
  for (const b of buttons) {
    const el = h('button.btn', { type: 'button', class: b.primary ? 'primary' : '' }, b.label) as HTMLButtonElement;
    if (b.primary && !primaryBtn) primaryBtn = el;
    el.addEventListener('click', async () => {
      if (b.onClick) { const r = await b.onClick(); if (r === false) return; }
      handle.close(b.value);
    });
    btnBox.appendChild(el);
  }
  if (o.preview) btnBox.appendChild(h('div.dialog-preview', null, checkbox('Preview', o.preview.checked, o.preview.onChange)));
  for (const x of o.sideExtras || []) btnBox.appendChild(x);

  win.querySelector('.dialog-x')!.addEventListener('click', () => handle.close(o.cancelValue ?? null));
  const onKey = (e: KeyboardEvent) => {
    if (stack[stack.length - 1] !== handle) return;
    if (e.key === 'Escape' && o.escClose !== false) { e.preventDefault(); e.stopPropagation(); handle.close(o.cancelValue ?? null); }
    else if (e.key === 'Enter' && primaryBtn && !(e.target as HTMLElement)?.matches?.('textarea, button, .select')) {
      e.preventDefault(); e.stopPropagation();
      (document.activeElement as HTMLElement)?.blur?.();
      setTimeout(() => primaryBtn!.click());
    }
    else e.stopPropagation(); // keep app shortcuts out while a dialog is open
  };
  window.addEventListener('keydown', onKey, true);

  // drag by title
  const title = win.querySelector('.dialog-title') as HTMLElement;
  title.addEventListener('pointerdown', e => {
    if ((e.target as Element).closest('button')) return;
    const r = win.getBoundingClientRect();
    win.style.position = 'fixed'; win.style.margin = '0';
    win.style.left = r.left + 'px'; win.style.top = r.top + 'px';
    dragPointer(e, (dx, dy) => { win.style.left = r.left + dx + 'px'; win.style.top = Math.max(0, r.top + dy) + 'px'; });
  });
  // focus first input
  setTimeout(() => (win.querySelector('input.field, input[type=text], textarea') as HTMLElement | null)?.focus());
  return handle;
}

export function alertDialog(title: string, message: string, iconName: 'info' | 'warning' = 'info'): Promise<void> {
  const body = h('div.msg-box', null, icon(iconName, 36, 'msg-icon'), h('div.msg-text', null, message));
  return openDialog({ title, body, buttons: [{ label: 'OK', primary: true }], width: 440 }).result;
}
/** Resolves with the chosen button's value (default 'ok' / 'cancel'). */
export function confirmDialog(title: string, message: string, buttons: DialogButton[] = [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: 'cancel' }]): Promise<any> {
  const body = h('div.msg-box', null, icon('warning', 36, 'msg-icon'), h('div.msg-text', null, message));
  return openDialog({ title, body, buttons, width: 460, cancelValue: 'cancel' }).result;
}
export function promptDialog(title: string, labelText: string, value = ''): Promise<string | null> {
  const inp = h('input.field', { type: 'text', value, style: { width: '260px' } }) as HTMLInputElement;
  inp.addEventListener('keydown', e => e.stopPropagation());
  const body = h('div.form', null, h('div.form-row', null, h('label.form-label', null, labelText), inp));
  const d = openDialog({ title, body, buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] });
  setTimeout(() => inp.select());
  return d.result.then(v => (v === 'ok' ? inp.value : null));
}
