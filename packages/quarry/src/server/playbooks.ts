/**
 * Playbook endpoint helpers for the Quarry server.
 *
 * Kept separate from `index.ts` so the request logic can be exercised
 * without constructing the full Hono app (database, broadcaster, auto-export).
 */

import {
  createPlaybook,
  discoverPlaybookFiles,
  loadPlaybookFromFile,
} from '@stoneforge/core';
import type { DiscoveredPlaybook, EntityId, Playbook } from '@stoneforge/core';

/** Response body for `GET /api/playbooks/:name`. */
export type PlaybookDetail = Playbook & {
  filePath: string;
  directory: string;
};

/**
 * Finds a playbook file by name (case-insensitive) in the given search paths
 * and returns the full, validated Playbook plus its file location.
 *
 * The Playbook object is built in memory only and is never inserted into
 * storage, so no IdGeneratorConfig is required.
 *
 * @returns The playbook detail, or `null` when no playbook matches `name`.
 */
export async function getPlaybookDetail(
  name: string,
  searchPaths: string[]
): Promise<PlaybookDetail | null> {
  const discovered = discoverPlaybookFiles(searchPaths, { recursive: true });
  const found = discovered.find(
    (p: DiscoveredPlaybook) => p.name.toLowerCase() === name.toLowerCase()
  );

  if (!found) {
    return null;
  }

  const playbookInput = loadPlaybookFromFile(found.path, 'system' as EntityId);
  const playbook = await createPlaybook(playbookInput);

  return {
    ...playbook,
    filePath: found.path,
    directory: found.directory,
  };
}
