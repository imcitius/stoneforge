/** Verify PTY spawning with the shipped Node runtime, without provider accounts. */
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const resources = resolve(process.argv[2]);
const require = createRequire(join(resources, 'backend/package.json'));
const { spawn } = require('node-pty');
let output = '';
const pty = spawn(process.execPath, ['-e', "console.log('STONEFORGE_PTY_OK')"], {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: resources, env: process.env,
});
await new Promise((done, reject) => {
  const timeout = setTimeout(() => { pty.kill(); reject(new Error('Packaged PTY timed out')); }, 5000);
  pty.onData(data => { output += data; });
  pty.onExit(({ exitCode }) => {
    clearTimeout(timeout);
    try { assert.equal(exitCode, 0); assert.match(output, /STONEFORGE_PTY_OK/); done(); }
    catch (error) { reject(error); }
  });
});
console.log('Packaged PTY: spawn, output and clean exit passed');
