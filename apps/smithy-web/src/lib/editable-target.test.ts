import { describe, expect, test } from 'vitest';
import { isEditableEventTarget } from './editable-target';

const target = (props: { tagName: string; isContentEditable?: boolean }) =>
  ({ isContentEditable: false, ...props }) as unknown as EventTarget;

describe('isEditableEventTarget', () => {
  test('input and textarea are editable', () => {
    expect(isEditableEventTarget(target({ tagName: 'INPUT' }))).toBe(true);
    expect(isEditableEventTarget(target({ tagName: 'TEXTAREA' }))).toBe(true);
  });

  test('contenteditable element (rich-text editor) is editable', () => {
    expect(isEditableEventTarget(target({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
    expect(isEditableEventTarget(target({ tagName: 'P', isContentEditable: true }))).toBe(true);
  });

  test('non-editable elements and missing targets are not editable', () => {
    expect(isEditableEventTarget(target({ tagName: 'DIV' }))).toBe(false);
    expect(isEditableEventTarget(target({ tagName: 'BODY' }))).toBe(false);
    expect(isEditableEventTarget(target({ tagName: 'BUTTON' }))).toBe(false);
    expect(isEditableEventTarget(null)).toBe(false);
  });
});
