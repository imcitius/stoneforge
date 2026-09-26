import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createDocument, createLibrary, type Document, type Element, type EntityId,
} from '@stoneforge/core';
import { createStorage, initializeSchema } from '@stoneforge/storage';
import { createQuarryAPI } from '../api/quarry-api.js';

const repository = resolve(import.meta.dir, '../../../..');
const entrypoints = ['quarry', 'smithy'].map(name => ({
  name,
  executable: 'node',
  prefix: [join(repository, `packages/${name}/dist/bin/sf.js`)],
}));
// Optional separate artifact verification still uses only the temporary fixture.
if (process.env.SF_TEST_CLI) {
  entrypoints.push({ name: 'artifact', executable: process.env.SF_TEST_CLI, prefix: [] });
}

let workspace: string;
let database: string;
let libraryId: string;
const documents: Document[] = [];
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(STONEFORGE_|SF_)/.test(key) || key === 'ORCHESTRATOR_URL') delete env[key];
}

beforeAll(async () => {
  // Always rebuild: a stale dist or a Bun-only source test can hide this Node bug.
  execFileSync('pnpm', ['--filter', '@stoneforge/smithy...', 'build'], {
    cwd: repository, env, timeout: 120_000, stdio: 'pipe',
  });
  workspace = mkdtempSync(join(tmpdir(), 'sf-piped-output-test-'));
  mkdirSync(join(workspace, '.stoneforge'));
  env.STONEFORGE_ROOT = workspace;
  database = join(workspace, '.stoneforge/stoneforge.db');
  const backend = createStorage({ path: database });
  initializeSchema(backend);
  const api = createQuarryAPI(backend);
  const actor = 'el-pipe-test' as EntityId;
  try {
    const library = await createLibrary({ name: 'Pipe fixture', createdBy: actor });
    await api.create(library as unknown as Element & Record<string, unknown>);
    libraryId = library.id;
    for (let index = 0; index < 4; index++) {
      const document = await createDocument({
        title: `Document ${index}`,
        content: `${index}:` + 'Привет שלום 世界 🙂\n'.repeat(8192) + `END-${index}`,
        contentType: 'text', createdBy: actor,
      });
      await api.create(document as unknown as Element & Record<string, unknown>);
      documents.push(document);
      await api.addDependency({
        blockedId: document.id, blockerId: library.id, type: 'parent-child', actor,
      });
    }
  } finally {
    backend.close();
  }
}, 120_000);

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

for (const entrypoint of entrypoints) {
  describe(`${entrypoint.name} built CLI with subprocess pipes`, () => {
    function run(args: string[], nodeOptions: string[] = []) {
      const result = spawnSync(entrypoint.executable, [
        ...nodeOptions, ...entrypoint.prefix, ...args, '--db', database,
      ], {
        cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024, timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      return result;
    }

    test('delivers every field of a >1 MiB Unicode JSON library response', () => {
      const result = run(['library', 'docs', libraryId, '--json']);
      expect(result.status).toBe(0);
      expect(result.stderr.toString()).toBe('');
      expect(result.stdout.length).toBeGreaterThan(1024 * 1024);
      const response = JSON.parse(result.stdout.toString());
      expect(response.success).toBe(true);
      expect(response.data).toHaveLength(documents.length);
      for (const document of documents) {
        expect(response.data.find((item: Document) => item.id === document.id)).toEqual(document);
      }
      expect(result.stdout.at(-1)).toBe(10);
    });

    test('preserves the plain library list', () => {
      const result = run(['library', 'docs', libraryId]);
      expect(result.status).toBe(0);
      expect(result.stderr.toString()).toBe('');
      const output = result.stdout.toString();
      for (const document of documents) {
        expect(output).toContain(document.id);
        expect(output).toContain(document.title!);
      }
      expect(output).toEndWith('4 document(s) in library\n');
    });

    test('delivers large plain document content including its Unicode tail', () => {
      const document = documents[0];
      const result = run(['document', 'show', document.id]);
      expect(result.status).toBe(0);
      expect(result.stderr.toString()).toBe('');
      expect(result.stdout.length).toBeGreaterThan(256 * 1024);
      expect(result.stdout.toString()).toContain(document.content);
    });

    test('preserves exact large content bytes in quiet mode', () => {
      const document = documents[0];
      const result = run(['document', 'show', document.id, '--quiet']);
      expect(result.status).toBe(0);
      expect(result.stderr.toString()).toBe('');
      expect(result.stdout.equals(Buffer.from(document.content + '\n'))).toBe(true);
    });

    for (const json of [false, true]) {
      test(`delivers large Unicode stderr and exit 2 (${json ? 'JSON' : 'plain'})`, () => {
        // Below the Linux per-argument size limit, but above the observed 64 KiB pipe cutoff.
        const command = 'unknown-' + 'é🙂'.repeat(12_000);
        const message = `Unknown command: ${command}\n\nRun "sf --help" to see available commands.`;
        const result = run([command, ...(json ? ['--json'] : [])]);
        expect(result.status).toBe(2);
        expect(result.stdout.length).toBe(0);
        expect(result.stderr.length).toBeGreaterThan(64 * 1024);
        if (json) {
          expect(JSON.parse(result.stderr.toString())).toEqual({ success: false, error: message, exitCode: 2 });
        } else {
          expect(result.stderr.toString()).toBe(`Error: ${message}\n`);
        }
      });

      test(`preserves command failure codes and streams (${json ? 'JSON' : 'plain'})`, () => {
        const cases = [
          { args: ['library', 'docs'], code: 2, message: 'Usage: sf library docs <library-id>' },
          { args: ['library', 'docs', 'el-missing'], code: 3, message: 'Library not found: el-missing' },
          { args: ['document', 'list', '--limit', '0'], code: 4, message: 'Limit must be a positive number' },
        ];
        for (const { args, code, message } of cases) {
          const result = run([...args, ...(json ? ['--json'] : [])]);
          expect(result.status).toBe(code);
          expect(result.stdout.length).toBe(0);
          if (json) {
            expect(JSON.parse(result.stderr.toString())).toEqual({ success: false, error: message, exitCode: code });
          } else {
            expect(result.stderr.toString()).toBe(`Error: ${message}\n`);
          }
        }
      });
    }

    if (entrypoint.executable === 'node') {
      test('still exits after output when a plugin leaves an active handle', () => {
        const result = run(['library', 'docs', libraryId, '--json'], [
          '--import', 'data:text/javascript,setInterval(() => {}, 60000)',
        ]);
        expect(result.status).toBe(0);
        expect(result.stderr.toString()).toBe('');
        expect(JSON.parse(result.stdout.toString()).data).toHaveLength(documents.length);
      });
    }
  });
}
