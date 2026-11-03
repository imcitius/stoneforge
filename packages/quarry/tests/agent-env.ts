/**
 * Test isolation from an inherited agent-session environment.
 *
 * Stoneforge agent sessions (Desktop, smithy workers/stewards) export variables
 * that point at the live project, actor and server. Tests that resolve the
 * workspace, the acting entity or a signing key would otherwise read them and
 * fail or touch real data. The variables handled here are:
 *
 * - Workspace/storage: STONEFORGE_ROOT, STONEFORGE_DB_PATH, STONEFORGE_UPLOAD_DIR,
 *   STONEFORGE_PROJECT_NODE
 * - Desktop session: STONEFORGE_DESKTOP_INSTANCE_ID, STONEFORGE_SESSION_ID
 * - Actor/identity: SF_ENTITY_ID, STONEFORGE_SIGN_KEY, STONEFORGE_SIGN_KEY_FILE
 * - Server routing: STONEFORGE_API_URL, ORCHESTRATOR_URL
 * - Config overrides (EnvVars): STONEFORGE_ACTOR, STONEFORGE_BASE_BRANCH,
 *   STONEFORGE_DB, STONEFORGE_CONFIG, STONEFORGE_JSON, STONEFORGE_VERBOSE,
 *   STONEFORGE_SYNC_AUTO_EXPORT, STONEFORGE_IDENTITY_MODE, STONEFORGE_DEMO_MODE
 *
 * Any other STONEFORGE_* or SF_* variable is cleared as well, matching
 * `checkEnvironment()` in scripts/check-merge.mjs. Explicit test opt-ins with the
 * SF_TEST_ prefix (for example SF_TEST_CLI) are preserved.
 */

export const AGENT_ENV_VARS = [
  'STONEFORGE_ROOT',
  'STONEFORGE_DB_PATH',
  'STONEFORGE_UPLOAD_DIR',
  'STONEFORGE_PROJECT_NODE',
  'STONEFORGE_DESKTOP_INSTANCE_ID',
  'STONEFORGE_SESSION_ID',
  'SF_ENTITY_ID',
  'STONEFORGE_SIGN_KEY',
  'STONEFORGE_SIGN_KEY_FILE',
  'STONEFORGE_API_URL',
  'ORCHESTRATOR_URL',
  'STONEFORGE_ACTOR',
  'STONEFORGE_BASE_BRANCH',
  'STONEFORGE_DB',
  'STONEFORGE_CONFIG',
  'STONEFORGE_JSON',
  'STONEFORGE_VERBOSE',
  'STONEFORGE_SYNC_AUTO_EXPORT',
  'STONEFORGE_IDENTITY_MODE',
  'STONEFORGE_DEMO_MODE',
] as const;

/** True for variables an agent session may leak into tests. */
export function isAgentEnvVar(name: string): boolean {
  if (name.startsWith('SF_TEST_')) return false;
  return (AGENT_ENV_VARS as readonly string[]).includes(name) || /^(STONEFORGE_|SF_)/.test(name);
}

/**
 * Snapshot and remove inherited agent-session variables from `env`.
 * Returns a function that restores exactly the removed values.
 */
export function isolateAgentEnv(env: NodeJS.ProcessEnv = process.env): () => void {
  const saved = new Map<string, string>();
  for (const name of Object.keys(env)) {
    if (!isAgentEnvVar(name)) continue;
    const value = env[name];
    if (value !== undefined) saved.set(name, value);
    delete env[name];
  }
  return () => {
    for (const name of Object.keys(env)) {
      if (isAgentEnvVar(name)) delete env[name];
    }
    for (const [name, value] of saved) env[name] = value;
  };
}
