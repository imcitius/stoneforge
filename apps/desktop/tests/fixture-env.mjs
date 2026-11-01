// Environment for fixture `sf` child processes. Tests often run inside a
// Desktop-managed agent session, which exports STONEFORGE_ROOT,
// STONEFORGE_DB_PATH, STONEFORGE_DESKTOP_INSTANCE_ID, SF_ENTITY_ID and similar.
// Inherited, they redirect fixture CLIs to the live workspace or make them
// demand a Desktop session context. Strip them, as scripts/check-tabs.mjs and
// ProjectManager.environment() do, then apply the fixture's own overrides.
export const isInheritedSessionKey = (key) =>
  /^(STONEFORGE_|SF_)/.test(key) || ['ORCHESTRATOR_URL', 'ELECTRON_RUN_AS_NODE'].includes(key);

export function fixtureEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (isInheritedSessionKey(key)) delete env[key];
  return { ...env, ...overrides };
}
