/**
 * Global 'v' then 'l'/'k' shortcut for switching the Tasks view mode.
 * Extracted from the route so it can be unit-tested without a DOM.
 */

import type { ViewMode } from '../../lib/task-constants';
import { isEditableEventTarget } from '../../lib/editable-target';

type ShortcutKeyEvent = Pick<KeyboardEvent, 'key' | 'target'>;

export function createViewModeShortcutHandlers(setViewMode: (mode: ViewMode) => void) {
  let pendingV = false;

  const handleKeyDown = (e: ShortcutKeyEvent) => {
    // Don't capture if user is typing in an input, textarea or contenteditable
    if (isEditableEventTarget(e.target)) {
      return;
    }

    if (e.key === 'v' || e.key === 'V') {
      pendingV = true;
      return;
    }

    if (pendingV) {
      if (e.key === 'l' || e.key === 'L') {
        setViewMode('list');
        pendingV = false;
      } else if (e.key === 'k' || e.key === 'K') {
        setViewMode('kanban');
        pendingV = false;
      } else {
        pendingV = false;
      }
    }
  };

  const handleKeyUp = () => {
    // Reset pending state after a short delay
    setTimeout(() => {
      pendingV = false;
    }, 500);
  };

  return { handleKeyDown, handleKeyUp };
}
