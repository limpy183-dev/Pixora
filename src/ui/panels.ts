// Panel registry. Feature modules call registerPanel(); the dock (ui/dock.ts) places them.
import type { MenuEntry } from './menu';

export interface PanelHooks {
  onShow?(): void;
  onHide?(): void;
  onResize?(): void;
  destroy?(): void;
}
export interface PanelDef {
  id: string;
  title: string;
  icon: string;
  /** Build contents into `el` (called once, lazily when first shown). */
  create(el: HTMLElement): void | PanelHooks;
  /** Items for the panel's flyout menu (≡). "Close" / "Close Tab Group" are appended automatically. */
  menu?(): MenuEntry[];
  /** Window menu shortcut, e.g. 'F7'. */
  shortcut?: string;
  minHeight?: number;
  /** Preferred height when docked in a new group. */
  defaultHeight?: number;
  /** Width when shown as a flyout / floating (default 300). */
  preferredWidth?: number;
}
export const panelDefs = new Map<string, PanelDef>();
export function registerPanel(def: PanelDef) { panelDefs.set(def.id, def); }
