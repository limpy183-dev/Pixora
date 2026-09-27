// Application menu bar + window controls.
import { h } from './dom';
import { icon } from './icons';
import { closeMenus, openMenu } from './menu';
import { buildMenus } from './menus-def';
import { runCommand } from '../core/commands';

export function createMenuBar(): HTMLElement {
  const menus = buildMenus();
  const bar = h('div.menubar');
  bar.appendChild(h('div.app-logo', { title: 'Pixora' }, icon('app-logo', 20)));
  let openIdx = -1;
  const titles: HTMLElement[] = [];
  const open = (i: number) => {
    openIdx = i;
    titles.forEach((t, j) => t.classList.toggle('open', i === j));
    openMenu(menus[i].items(), titles[i], { onClose: () => { if (openIdx === i) { openIdx = -1; titles[i].classList.remove('open'); } } });
  };
  menus.forEach((m, i) => {
    const t = h('div.menu-title', { 'data-menu-anchor': '' }, m.label);
    t.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (openIdx === i) { closeMenus(); openIdx = -1; t.classList.remove('open'); }
      else open(i);
    });
    t.addEventListener('pointerenter', () => { if (openIdx >= 0 && openIdx !== i) open(i); });
    titles.push(t);
    bar.appendChild(t);
  });
  bar.appendChild(h('div.menubar-drag'));
  const isFull = () => !!document.fullscreenElement;
  const maxBtn = h('button.win-btn', { type: 'button', title: 'Maximize (full screen)' }, icon('win-restore', 16));
  maxBtn.addEventListener('click', () => {
    if (isFull()) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => { maxBtn.replaceChildren(icon(isFull() ? 'win-restore' : 'win-max', 16)); });
  bar.append(
    h('div.win-controls', null,
      h('button.win-btn', { type: 'button', title: 'Minimize (hide panels)', onclick: () => runCommand('view.togglePanels') }, icon('win-min', 16)),
      maxBtn,
      h('button.win-btn.close', { type: 'button', title: 'Close all documents', onclick: () => runCommand('file.closeAll') }, icon('win-close', 16)),
    ),
  );
  // Alt → focus menus (F10 like)
  return bar;
}
