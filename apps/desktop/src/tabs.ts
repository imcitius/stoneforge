/**
 * Project tab model for the title-bar tab strip: order, status presentation and the
 * window-level selection shortcuts. Pure functions, shared by the main process and tests.
 */

export type ProjectState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'error';
export type StatusKind = 'running' | 'stopped' | 'busy' | 'error' | 'attention';
export type TabStatus = { kind: StatusKind; label: string; symbol: string };

/** Status dot and text for one tab. A pending human decision outranks the backend state. */
export function projectStatus(project: { state: ProjectState; needsInput?: boolean; error?: string }): TabStatus {
  if (project.needsInput) return { kind: 'attention', label: 'Needs your input', symbol: '!' };
  switch (project.state) {
    case 'ready': return { kind: 'running', label: 'Running', symbol: '●' };
    case 'starting': return { kind: 'busy', label: 'Starting…', symbol: '◌' };
    case 'stopping': return { kind: 'busy', label: 'Stopping…', symbol: '◌' };
    case 'error': return { kind: 'error', label: project.error ? `Error: ${project.error}` : 'Error', symbol: '✕' };
    default: return { kind: 'stopped', label: 'Stopped', symbol: '○' };
  }
}

/**
 * Display order: ids from the saved order first, then every other project in registry
 * order. Unknown saved ids (removed projects) are ignored. Does not mutate its input.
 */
export function orderProjects<T extends { id: string }>(projects: readonly T[], order: readonly string[]): T[] {
  const rank = new Map<string, number>();
  order.forEach((id, index) => { if (!rank.has(id)) rank.set(id, index); });
  return projects
    .map((project, index) => ({ project, key: rank.get(project.id) ?? order.length + index }))
    .sort((a, b) => a.key - b.key)
    .map(({ project }) => project);
}

/**
 * Validates a requested order from the renderer. Returns the complete order of `known`
 * (requested known ids first, remaining ids after in their current order), or undefined
 * when the request is not an array of strings.
 */
export function normalizeOrder(requested: unknown, known: readonly string[]): string[] | undefined {
  if (!Array.isArray(requested) || requested.length > 10_000 || !requested.every((id) => typeof id === 'string')) return undefined;
  const knownSet = new Set(known);
  const result: string[] = [];
  for (const id of requested as string[]) if (knownSet.has(id) && !result.includes(id)) result.push(id);
  for (const id of known) if (!result.includes(id)) result.push(id);
  return result;
}

/** Moves `id` by `delta` positions within `order`, clamped at the ends. */
export function moveProject(order: readonly string[], id: string, delta: number): string[] {
  const from = order.indexOf(id);
  if (from < 0) return [...order];
  const to = Math.max(0, Math.min(order.length - 1, from + delta));
  const result = order.filter((item) => item !== id);
  result.splice(to, 0, id);
  return result;
}

export type ShortcutInput = { type?: string; key?: string; code?: string; meta?: boolean; control?: boolean; alt?: boolean; shift?: boolean };
export type TabShortcut = { kind: 'index'; index: number } | { kind: 'last' } | { kind: 'next' } | { kind: 'previous' };

/**
 * Browser-style tab shortcuts: ⌘1…⌘8 select that tab, ⌘9 the last one, ⌃Tab / ⌃⇧Tab cycle.
 * Digits are matched by physical key first so keyboard layouts that shift digits still work.
 */
export function tabShortcut(input: ShortcutInput): TabShortcut | undefined {
  if (input.type !== undefined && input.type !== 'keyDown' && input.type !== 'rawKeyDown') return undefined;
  if (input.meta && !input.control && !input.alt && !input.shift) {
    const digit = /^Digit([1-9])$/.exec(input.code ?? '')?.[1] ?? /^([1-9])$/.exec(input.key ?? '')?.[1];
    if (!digit) return undefined;
    return digit === '9' ? { kind: 'last' } : { kind: 'index', index: Number(digit) - 1 };
  }
  if (input.control && !input.meta && !input.alt && (input.key === 'Tab' || input.code === 'Tab')) {
    return input.shift ? { kind: 'previous' } : { kind: 'next' };
  }
  return undefined;
}

/** Project selected by a shortcut, or undefined when there is no such tab. Cycling wraps. */
export function shortcutTarget(shortcut: TabShortcut, ids: readonly string[], active: string | undefined): string | undefined {
  if (!ids.length) return undefined;
  if (shortcut.kind === 'index') return ids[shortcut.index];
  if (shortcut.kind === 'last') return ids[ids.length - 1];
  const current = active === undefined ? -1 : ids.indexOf(active);
  if (current < 0) return shortcut.kind === 'next' ? ids[0] : ids[ids.length - 1];
  const step = shortcut.kind === 'next' ? 1 : -1;
  return ids[(current + step + ids.length) % ids.length];
}
