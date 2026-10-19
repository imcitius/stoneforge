import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Window-level shell preferences. Stored in Electron userData, never in a project. */
export type Preferences = { sidebarCollapsed: boolean };

export const SIDEBAR_WIDTH = 240;
export const TOOLBAR_HEIGHT = 64;
const defaults: Preferences = { sidebarCollapsed: false };

export function preferencesFile(dataDir: string): string { return join(dataDir, 'preferences.json'); }

/** Missing, unreadable or malformed preferences fall back to the visible sidebar. */
export async function loadPreferences(dataDir: string): Promise<Preferences> {
  try {
    const value: unknown = JSON.parse(await readFile(preferencesFile(dataDir), 'utf8'));
    const collapsed = (value as { sidebarCollapsed?: unknown } | null)?.sidebarCollapsed;
    return { sidebarCollapsed: typeof collapsed === 'boolean' ? collapsed : defaults.sidebarCollapsed };
  } catch { return { ...defaults }; }
}

let pending = Promise.resolve();
/** Serialized atomic write, so rapid toggles cannot interleave or leave a partial file. */
export function savePreferences(dataDir: string, preferences: Preferences): Promise<void> {
  const data = JSON.stringify({ sidebarCollapsed: preferences.sidebarCollapsed }, null, 2) + '\n';
  pending = pending.catch(() => {}).then(async () => {
    await mkdir(dataDir, { recursive: true });
    const temporary = preferencesFile(dataDir) + '.tmp';
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, preferencesFile(dataDir));
  });
  return pending;
}

/** Project dashboard bounds beneath the shell toolbar and beside the optional sidebar. */
export function projectBounds(width: number, height: number, sidebarCollapsed: boolean) {
  const x = sidebarCollapsed ? 0 : SIDEBAR_WIDTH;
  return { x, y: TOOLBAR_HEIGHT, width: Math.max(0, width - x), height: Math.max(0, height - TOOLBAR_HEIGHT) };
}
