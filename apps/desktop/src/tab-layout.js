/*
 * Pure layout and keyboard helpers for the shell's project tab strip. A classic script
 * (the shell page has no module loader); Desktop node tests evaluate it with node:vm.
 */
(function (root) {
  'use strict';

  /**
   * Equal-width tabs, like browser tabs: they share the available width up to `max`,
   * shrink down to `min`, and only then the remainder moves to the » overflow menu
   * (whose button takes `overflow` pixels). At least one tab always stays visible.
   */
  function fitTabs({ count, available, min, max, overflow }) {
    if (count <= 0) return { visible: 0, width: max };
    const space = Math.max(0, available);
    if (count * min <= space) return { visible: count, width: Math.min(max, Math.floor(space / count)) };
    const visible = Math.max(1, Math.min(count - 1, Math.floor((space - overflow) / min)));
    return { visible, width: Math.max(min, Math.min(max, Math.floor((space - overflow) / visible))) };
  }

  /**
   * Splits ordered ids into shown tabs and overflow. Order is preserved; when the active
   * project would overflow it takes the last visible slot, so the active tab is always shown.
   */
  function splitTabs(ids, active, visible) {
    const count = Math.max(0, Math.min(visible, ids.length));
    let shown = ids.slice(0, count);
    if (count > 0 && active !== undefined && ids.includes(active) && !shown.includes(active)) {
      shown = [...ids.slice(0, count - 1), active];
    }
    return { shown, hidden: ids.filter((id) => !shown.includes(id)) };
  }

  /** Roving focus inside the tablist (WAI-ARIA tabs, manual activation); wraps at the ends. */
  function focusTarget(key, index, count) {
    if (count <= 0) return undefined;
    if (key === 'ArrowRight') return index < 0 ? 0 : (index + 1) % count;
    if (key === 'ArrowLeft') return index < 0 ? count - 1 : (index - 1 + count) % count;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return undefined;
  }

  /** Order after dropping `dragged` before (or after) `target`; unchanged for a no-op drop. */
  function dropOrder(ids, dragged, target, after) {
    if (dragged === target || !ids.includes(dragged) || !ids.includes(target)) return [...ids];
    const result = ids.filter((id) => id !== dragged);
    result.splice(result.indexOf(target) + (after ? 1 : 0), 0, dragged);
    return result;
  }

  root.StoneforgeTabLayout = Object.freeze({ fitTabs, splitTabs, focusTarget, dropOrder });
})(globalThis);
