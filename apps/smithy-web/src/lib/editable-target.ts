/**
 * Returns true when a keyboard event target is a text-editing surface
 * (input, textarea or contenteditable element, e.g. a rich-text editor).
 *
 * Global single-key shortcuts such as '/' to focus search must not fire
 * (or call preventDefault) when the user is typing in one of these.
 */
export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
}
