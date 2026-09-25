/**
 * Opt-in live provider check. Uses existing CLI authentication and consumes
 * model quota. Run: bun scripts/check-agent-compatibility.ts codex|claude-code
 * Creates only a temporary workspace; does not dispatch Stoneforge tasks.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexAgentProvider } from '../packages/smithy/src/providers/codex/index.js';
import { ClaudeAgentProvider } from '../packages/smithy/src/providers/claude/index.js';
import type { HeadlessSession } from '../packages/smithy/src/providers/types.js';

const name = process.argv[2];
if (name !== 'codex' && name !== 'claude-code') {
  throw new Error('Usage: bun scripts/check-agent-compatibility.ts codex|claude-code');
}
const provider = name === 'codex' ? new CodexAgentProvider() : new ClaudeAgentProvider();
const workspace = await mkdtemp(join(tmpdir(), 'stoneforge-compat-'));
const originalDirectory = process.cwd();
process.chdir(workspace);
const marker = `sf-${randomUUID()}`;
let activeSession: HeadlessSession | undefined;

async function collect(session: HeadlessSession): Promise<{ sessionId: string; text: string }> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      (async () => {
        let sessionId = '';
        let text = '';
        for await (const message of session) {
          if (message.sessionId) sessionId = message.sessionId;
          if (message.type === 'assistant' && message.content) text += message.content;
          if (message.type === 'error') throw new Error(message.content ?? 'Provider error');
          if (message.type === 'result') {
            if (message.subtype !== 'success') throw new Error(`Turn ended with ${message.subtype}`);
            return { sessionId, text: text || message.content || '' };
          }
        }
        throw new Error('Session ended without a result');
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Provider check timed out after 90 seconds')), 90_000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
    session.close();
  }
}

try {
  const models = await provider.listModels();
  if (!models.length) throw new Error('Model catalog is empty');
  activeSession = await provider.headless.spawn({
    workingDirectory: workspace,
    initialPrompt: `Do not use tools or change files. Remember the code ${marker}. Reply with exactly READY.`,
  });
  const first = await collect(activeSession);
  if (!first.sessionId || !first.text.includes('READY')) throw new Error('Initial turn did not initialize successfully');
  activeSession = await provider.headless.spawn({
    workingDirectory: workspace,
    resumeSessionId: first.sessionId,
    initialPrompt: 'Do not use tools. Reply with only the code I asked you to remember.',
  });
  const resumed = await collect(activeSession);
  if (resumed.sessionId !== first.sessionId || !resumed.text.includes(marker)) {
    throw new Error('Resumed session did not preserve conversation history');
  }
  console.log(JSON.stringify({ provider: name, models: models.length, start: 'passed', resume: 'passed', close: 'requested' }));
} finally {
  activeSession?.close();
  process.chdir(originalDirectory);
  await rm(workspace, { recursive: true, force: true });
}
