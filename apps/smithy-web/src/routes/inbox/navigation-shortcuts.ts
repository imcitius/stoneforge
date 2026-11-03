/**
 * Global 'j'/'k' inbox navigation shortcut.
 * Extracted from the route so it can be unit-tested without a DOM.
 */

import { isEditableEventTarget } from '../../lib/editable-target';

/** Returns the navigation direction for a keydown, or null when it must be ignored. */
export function getInboxNavigationDirection(
  e: Pick<KeyboardEvent, 'key' | 'target'>
): 'next' | 'prev' | null {
  // Ignore if typing in an input, textarea or contenteditable
  if (isEditableEventTarget(e.target)) {
    return null;
  }
  if (e.key === 'j' || e.key === 'J') return 'next';
  if (e.key === 'k' || e.key === 'K') return 'prev';
  return null;
}
