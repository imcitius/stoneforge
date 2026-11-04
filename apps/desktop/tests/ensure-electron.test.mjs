import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { MANIFEST, distEntries, ensureElectron, readZipEntries, verifyDist } from '../scripts/ensure-electron.mjs';

const EXECUTABLE = 'Electron.app/Contents/MacOS/Electron';
const FRAMEWORK = 'Electron.app/Contents/Frameworks/F.framework/Versions/A/F';
// What an Electron release zip holds: directories, files, a framework symlink and electron.d.ts,
// which install.js moves out of dist.
const ENTRIES = [
  { name: 'Electron.app/', type: 'directory' },
  { name: 'version', type: 'file', data: '1.2.3' },
  { name: EXECUTABLE, type: 'file', data: 'executable' },
  { name: FRAMEWORK, type: 'file', data: 'x'.repeat(4096) },
  { name: 'Electron.app/Contents/Frameworks/F.framework/F', type: 'symlink', data: 'Versions/A/F' },
  { name: 'electron.d.ts', type: 'file', data: 'declare module "electron";' },
];

// A minimal stored (uncompressed) zip with Unix modes, as Electron's release zips have.
function writeZip(path, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? '');
    const mode = { directory: 0o040755, file: 0o100644, symlink: 0o120755 }[entry.type];
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt8(20, 4); central.writeUInt8(3, 5); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(mode * 0x10000, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...locals, cd, end]));
}

// Mirrors electron/install.js: extract into dist, move electron.d.ts out, then write path.txt.
function extract(electronDir) {
  for (const entry of ENTRIES) {
    if (entry.type === 'directory') continue;
    const target = entry.name === 'electron.d.ts' ? join(electronDir, entry.name) : join(electronDir, 'dist', entry.name);
    mkdirSync(dirname(target), { recursive: true });
    if (entry.type === 'symlink') symlinkSync(entry.data, target);
    else writeFileSync(target, entry.data);
  }
  writeFileSync(join(electronDir, 'path.txt'), EXECUTABLE);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ensure-electron-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const electronDir = join(root, 'electron');
  mkdirSync(electronDir);
  writeFileSync(join(electronDir, 'package.json'), JSON.stringify({ name: 'electron', version: '1.2.3' }));
  const zip = join(root, 'electron-v1.2.3-darwin-arm64.zip');
  writeZip(zip, ENTRIES);
  const calls = { download: 0, install: 0 };
  const options = {
    electronDir, platform: 'darwin', log: () => {},
    download: async () => { calls.download++; return zip; },
    install: () => { calls.install++; extract(electronDir); },
  };
  return { root, electronDir, zip, calls, options };
}

test('reads files, sizes and symlinks from the zip central directory', (t) => {
  const { zip } = fixture(t);
  assert.deepEqual(readZipEntries(zip), [
    { name: 'version', type: 'file', size: 5 },
    { name: EXECUTABLE, type: 'file', size: 10 },
    { name: FRAMEWORK, type: 'file', size: 4096 },
    { name: 'Electron.app/Contents/Frameworks/F.framework/F', type: 'symlink', size: 12 },
    { name: 'electron.d.ts', type: 'file', size: 26 },
  ]);
});

test('a fresh install runs install.js once and later runs only check the stored sizes', async (t) => {
  const { electronDir, calls, options } = fixture(t);
  assert.equal(await ensureElectron(options), 'installed');
  assert.deepEqual(calls, { download: 1, install: 1 });
  const manifest = JSON.parse(readFileSync(join(electronDir, 'dist', MANIFEST), 'utf8'));
  assert.deepEqual(manifest.entries.map(entry => entry.name).sort(),
    ['Electron.app/Contents/Frameworks/F.framework/F', EXECUTABLE, FRAMEWORK, 'version'].sort());
  assert.equal(await ensureElectron(options), 'verified');
  assert.deepEqual(calls, { download: 1, install: 1 }, 'a verified dist needs neither the zip nor install.js');
});

test('a dist truncated by an interrupted extraction is detected and reinstalled', async (t) => {
  const { electronDir, zip, calls, options } = fixture(t);
  // The el-2r3sey state: install.js would accept this (version, path.txt and executable exist).
  extract(electronDir);
  truncateSync(join(electronDir, 'dist', FRAMEWORK), 1000);
  assert.deepEqual(verifyDist(join(electronDir, 'dist'), distEntries(zip)),
    [`${FRAMEWORK}: 1000 bytes, expected 4096`]);
  const logs = [];
  assert.equal(await ensureElectron({ ...options, log: line => logs.push(line) }), 'installed');
  assert.equal(calls.install, 1);
  assert.match(logs.join('\n'), /F: 1000 bytes, expected 4096\); reinstalling once/);
  assert.deepEqual(verifyDist(join(electronDir, 'dist'), distEntries(zip)), []);
  // A later truncation is caught by the stored manifest as well.
  truncateSync(join(electronDir, 'dist', FRAMEWORK), 10);
  assert.equal(await ensureElectron(options), 'installed');
  assert.equal(calls.install, 2);
});

test('an existing complete dist is verified against the zip and kept', async (t) => {
  const { electronDir, calls, options } = fixture(t);
  extract(electronDir);
  assert.equal(await ensureElectron(options), 'verified');
  assert.deepEqual(calls, { download: 1, install: 0 });
});

test('missing files, symlinks and a failed install fail closed', async (t) => {
  const { electronDir, zip, options } = fixture(t);
  extract(electronDir);
  const dist = join(electronDir, 'dist');
  rmSync(join(dist, 'Electron.app/Contents/Frameworks/F.framework/F'));
  writeFileSync(join(dist, 'Electron.app/Contents/Frameworks/F.framework/F'), 'Versions/A/F');
  rmSync(join(dist, EXECUTABLE));
  assert.deepEqual(verifyDist(dist, distEntries(zip)), [
    `${EXECUTABLE}: missing`, 'Electron.app/Contents/Frameworks/F.framework/F: not a symlink']);
  await assert.rejects(ensureElectron({ ...options, install: () => {} }), /install\.js did not write dist\/version and path\.txt/);
  const partial = () => { extract(electronDir); truncateSync(join(dist, FRAMEWORK), 1); };
  await assert.rejects(ensureElectron({ ...options, install: partial }), /install is still incomplete: .*F: 1 bytes, expected 4096/);
  await assert.rejects(ensureElectron({ ...options, probe: () => { throw new Error('dyld: truncated'); } }), /dyld: truncated/);
});

// The el-2r3sey race: parallel processes (node --test files) each needing Electron at once.
test('concurrent processes install exactly once', async (t) => {
  const { root, electronDir, zip } = fixture(t);
  const counter = join(root, 'installs');
  const module = new URL('../scripts/ensure-electron.mjs', import.meta.url).href;
  const extractSource = extract.toString();
  const script = `
    import { mkdirSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    import { ensureElectron } from ${JSON.stringify(module)};
    const EXECUTABLE = ${JSON.stringify(EXECUTABLE)};
    const ENTRIES = ${JSON.stringify(ENTRIES)};
    ${extractSource}
    const result = await ensureElectron({
      electronDir: ${JSON.stringify(electronDir)}, platform: 'darwin', log: () => {},
      download: async () => ${JSON.stringify(zip)},
      install: () => {
        appendFileSync(${JSON.stringify(counter)}, 'x');
        // Hold the lock long enough for every other process to contend for it.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        extract(${JSON.stringify(electronDir)});
      },
    });
    console.log(result);
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
  });
  const results = await Promise.all([run(), run(), run(), run()]);
  assert.equal(readFileSync(counter, 'utf8'), 'x', 'install.js ran more than once');
  assert.deepEqual(results.sort(), ['installed', 'verified', 'verified', 'verified']);
});
