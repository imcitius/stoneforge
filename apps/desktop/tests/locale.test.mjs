import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ProjectManager } from '../dist/manager.js';

// Exercise the actual environment passed to the managed backend, including
// LC_ALL precedence. No system clipboard writes are needed for these checks.
test('Finder and non-UTF-8 environments give terminal helpers a UTF-8 character locale', () => {
  const keys = ['LANG', 'LC_CTYPE', 'LC_ALL'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const manager = new ProjectManager({ dataDir: '/tmp/unused', node: process.execPath, entry: '/tmp/unused', webRoot: '/tmp/unused', binDir: '/tmp/unused' });
  try {
    for (const fixture of [{}, { LANG: 'C' }, { LC_ALL: 'C', LANG: 'en_US.UTF-8' }, { LC_CTYPE: 'C', LANG: 'en_US.UTF-8' }, { LANG: 'ru_RU.UTF-8' }]) {
      for (const key of keys) {
        if (fixture[key] === undefined) delete process.env[key];
        else process.env[key] = fixture[key];
      }
      const env = manager.environment('/tmp/project');
      assert.match(env.LC_ALL || env.LC_CTYPE || env.LANG, /utf-?8/i);
      if (process.platform === 'darwin') {
        assert.equal(execFileSync('/usr/bin/locale', ['charmap'], { env, encoding: 'utf8' }).trim(), 'UTF-8');
      }
      for (const key of keys) assert.equal(process.env[key], fixture[key], 'parent environment stays unchanged');
      if (fixture.LANG === 'ru_RU.UTF-8') assert.equal(env.LANG, fixture.LANG);
    }
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
