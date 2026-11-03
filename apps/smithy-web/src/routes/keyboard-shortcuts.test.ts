import { describe, expect, test, vi } from 'vitest';
import { createViewModeShortcutHandlers } from './tasks/view-mode-shortcuts';
import { getInboxNavigationDirection } from './inbox/navigation-shortcuts';
import { handleMergeRequestListKey } from './merge-requests/list-shortcuts';

const target = (tagName: string, isContentEditable = false) =>
  ({ tagName, isContentEditable }) as unknown as EventTarget;

const contentEditable = target('DIV', true);
const body = target('BODY');

const keyEvent = (key: string, eventTarget: EventTarget, mods: { metaKey?: boolean; ctrlKey?: boolean } = {}) => ({
  key,
  target: eventTarget,
  metaKey: mods.metaKey ?? false,
  ctrlKey: mods.ctrlKey ?? false,
  preventDefault: vi.fn(),
});

describe('tasks view-mode shortcut (v then l/k)', () => {
  test('switches view from a non-editable target', () => {
    const setViewMode = vi.fn();
    const { handleKeyDown } = createViewModeShortcutHandlers(setViewMode);
    handleKeyDown(keyEvent('v', body));
    handleKeyDown(keyEvent('k', body));
    handleKeyDown(keyEvent('v', body));
    handleKeyDown(keyEvent('l', body));
    expect(setViewMode.mock.calls).toEqual([['kanban'], ['list']]);
  });

  test('typing v then l/k in a contenteditable does not switch view', () => {
    const setViewMode = vi.fn();
    const { handleKeyDown } = createViewModeShortcutHandlers(setViewMode);
    for (const key of ['v', 'l', 'v', 'k']) handleKeyDown(keyEvent(key, contentEditable));
    // 'v' typed in the editor must not arm the chord for a following key elsewhere
    handleKeyDown(keyEvent('k', body));
    for (const key of ['v', 'l']) handleKeyDown(keyEvent(key, target('INPUT')));
    for (const key of ['v', 'k']) handleKeyDown(keyEvent(key, target('TEXTAREA')));
    expect(setViewMode).not.toHaveBeenCalled();
  });
});

describe('inbox j/k navigation shortcut', () => {
  test('navigates from a non-editable target', () => {
    expect(getInboxNavigationDirection(keyEvent('j', body))).toBe('next');
    expect(getInboxNavigationDirection(keyEvent('K', body))).toBe('prev');
    expect(getInboxNavigationDirection(keyEvent('x', body))).toBeNull();
  });

  test('typing j/k in a contenteditable, input or textarea does not navigate', () => {
    for (const t of [contentEditable, target('INPUT'), target('TEXTAREA')]) {
      expect(getInboxNavigationDirection(keyEvent('j', t))).toBeNull();
      expect(getInboxNavigationDirection(keyEvent('k', t))).toBeNull();
    }
  });
});

describe('merge requests list shortcuts', () => {
  const actions = () => ({ next: vi.fn(), prev: vi.fn(), open: vi.fn(), close: vi.fn(), refresh: vi.fn() });

  test('handles j/k/Enter/Escape/r from a non-editable target', () => {
    const a = actions();
    const events = ['j', 'k', 'Enter', 'Escape', 'r'].map((key) => keyEvent(key, body));
    for (const e of events) handleMergeRequestListKey(e, a);
    for (const fn of Object.values(a)) expect(fn).toHaveBeenCalledTimes(1);
    for (const e of events) expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  test('r with Cmd/Ctrl is left to the browser', () => {
    const a = actions();
    const e = keyEvent('r', body, { metaKey: true });
    handleMergeRequestListKey(e, a);
    handleMergeRequestListKey(keyEvent('r', body, { ctrlKey: true }), a);
    expect(a.refresh).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  test('typing in a contenteditable, input or textarea neither triggers nor swallows keys', () => {
    for (const t of [contentEditable, target('INPUT'), target('TEXTAREA')]) {
      const a = actions();
      for (const key of ['j', 'k', 'Enter', 'Escape', 'r']) {
        const e = keyEvent(key, t);
        handleMergeRequestListKey(e, a);
        expect(e.preventDefault).not.toHaveBeenCalled();
      }
      for (const fn of Object.values(a)) expect(fn).not.toHaveBeenCalled();
    }
  });
});
