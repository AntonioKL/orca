/** Interactive chrome living inside the draggable titlebar. `[data-tab-id]` covers
 *  every tab kind (terminal, browser, editor, simulator, client-hosted row): a press
 *  on a tab starts a dnd-kit reorder, so it must never also move the panel. */
const FLOATING_TERMINAL_NO_DRAG_SELECTOR =
  'button,input,textarea,select,[role="menuitem"],[data-tab-id],[data-floating-terminal-no-drag]'

export function isFloatingTerminalDragTarget(target: EventTarget): boolean {
  return !(target instanceof HTMLElement && target.closest(FLOATING_TERMINAL_NO_DRAG_SELECTOR))
}
