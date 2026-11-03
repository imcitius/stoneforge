/**
 * Global j/k/Enter/Escape/r shortcuts for the merge requests list.
 * Extracted from the route so it can be unit-tested without a DOM.
 */

import { isEditableEventTarget } from '../../lib/editable-target';

export interface MergeRequestListShortcutActions {
  next: () => void;
  prev: () => void;
  open: () => void;
  close: () => void;
  refresh: () => void;
}

type ShortcutKeyEvent = Pick<KeyboardEvent, 'key' | 'target' | 'metaKey' | 'ctrlKey' | 'preventDefault'>;

export function handleMergeRequestListKey(e: ShortcutKeyEvent, actions: MergeRequestListShortcutActions): void {
  // Don't capture (or preventDefault) if user is typing in an input, textarea or contenteditable
  if (isEditableEventTarget(e.target)) {
    return;
  }

  switch (e.key) {
    case 'j': // Next item
      e.preventDefault();
      actions.next();
      break;
    case 'k': // Previous item
      e.preventDefault();
      actions.prev();
      break;
    case 'Enter': // Open detail
      e.preventDefault();
      actions.open();
      break;
    case 'Escape': // Close panel
      e.preventDefault();
      actions.close();
      break;
    case 'r': // Refresh
      if (!e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        actions.refresh();
      }
      break;
  }
}
