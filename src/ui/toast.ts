// Transient notifications (bottom-center).
let host: HTMLElement | null = null;

export function toast(msg: string, kind: 'info' | 'error' | 'success' = 'info', ms = 2600) {
  if (!host) { host = document.createElement('div'); host.className = 'toast-host'; document.body.appendChild(host); }
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.textContent = msg;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, ms);
}
