/**
 * Bun test preload (see bunfig.toml): runs before any test module is imported,
 * so module-level reads of process.env already see the isolated environment.
 */
import { afterAll } from 'bun:test';
import { isolateAgentEnv } from './agent-env.js';

const restore = isolateAgentEnv();
afterAll(restore);
