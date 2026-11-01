import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Window-level shell preferences. Stored in Electron userData, never in a project.
 * `projectOrder` is the user's tab order (project IDs); projects missing from it keep
 * registry order after the ordered ones. Keys from older versions (the removed
 * `sidebarCollapsed`) are ignored and dropped on the next save.
 */
export type Preferences = { projectOrder: string[] };

/** Title bar with the project tabs (macOS traffic lights sit inside it). */
export const TAB_BAR_HEIGHT = 38;
/** Project toolbar beneath the tabs: path, project actions and build identity. */
export const TOOLBAR_HEIGHT = 38;
export const SHELL_TOP = TAB_BAR_HEIGHT + TOOLBAR_HEIGHT;

export function preferencesFile(dataDir: string): string { return join(dataDir, 'preferences.json'); }

function cleanOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/** Missing, unreadable or malformed preferences fall back to registry order. */
export async function loadPreferences(dataDir: string): Promise<Preferences> {
  try {
    const value: unknown = JSON.parse(await readFile(preferencesFile(dataDir), 'utf8'));
    return { projectOrder: cleanOrder((value as { projectOrder?: unknown } | null)?.projectOrder) };
  } catch { return { projectOrder: [] }; }
}

let pending = Promise.resolve();
/** Serialized atomic write, so rapid reorders cannot interleave or leave a partial file. */
export function savePreferences(dataDir: string, preferences: Preferences): Promise<void> {
  const data = JSON.stringify({ projectOrder: cleanOrder(preferences.projectOrder) }, null, 2) + '\n';
  pending = pending.catch(() => {}).then(async () => {
    await mkdir(dataDir, { recursive: true });
    const temporary = preferencesFile(dataDir) + '.tmp';
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, preferencesFile(dataDir));
  });
  return pending;
}

/** Project dashboard bounds: the full window width beneath the tab bar and toolbar. */
export function projectBounds(width: number, height: number) {
  return { x: 0, y: SHELL_TOP, width: Math.max(0, width), height: Math.max(0, height - SHELL_TOP) };
}
