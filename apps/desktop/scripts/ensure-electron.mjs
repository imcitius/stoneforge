#!/usr/bin/env node
// Installs and verifies the pinned development Electron binary exactly once, before anything
// requires `electron` (el-2r3sey).
//
// Electron 44's package has no install script: `require('electron')` (index.js) runs install.js
// whenever dist/<executable> is missing, without any lock. `node --test` runs test files in
// parallel processes, so on a fresh checkout two Electron tests start two extractions into the
// same dist directory. One of them can fail ("Input/output error (os error 5)") and the dist can
// be left with truncated files that install.js later accepts because it only checks that the
// executable exists. A truncated Electron Framework then crashes every development launch.
//
// This script takes a lock, checks every file of dist against the official (checksum-verified)
// release zip, and only when that check fails removes dist and runs Electron's own install.js
// once. The verified sizes are stored in dist so later runs check them without the zip. On macOS
// it finally runs the binary (as Node) to prove it loads.
//
//   node scripts/ensure-electron.mjs     (pnpm --filter @stoneforge/desktop ensure-electron)
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, openSync, readFileSync, readSync, closeSync, fstatSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const MANIFEST = '.stoneforge-verified.json';
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

/** Files, directories and symlinks of a zip archive, read from its central directory. */
export function readZipEntries(zipPath) {
  const fd = openSync(zipPath, 'r');
  try {
    const size = fstatSync(fd).size;
    const read = (position, length) => {
      const buffer = Buffer.alloc(length);
      if (readSync(fd, buffer, 0, length, position) !== length) throw new Error(`${zipPath}: unexpected end of file`);
      return buffer;
    };
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = read(size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error(`${zipPath}: not a zip archive (no end of central directory)`);
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new Error(`${zipPath}: missing zip64 locator`);
      const record = read(Number(tail.readBigUInt64LE(locator + 8)), 56);
      if (record.readUInt32LE(0) !== 0x06064b50) throw new Error(`${zipPath}: bad zip64 end record`);
      count = Number(record.readBigUInt64LE(32));
      cdSize = Number(record.readBigUInt64LE(40));
      cdOffset = Number(record.readBigUInt64LE(48));
    }
    const cd = read(cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`${zipPath}: bad central directory entry ${n}`);
      const host = cd.readUInt8(p + 5);
      let compressed = cd.readUInt32LE(p + 20);
      let uncompressed = cd.readUInt32LE(p + 24);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      const mode = host === 3 ? cd.readUInt32LE(p + 38) >>> 16 : 0;
      const name = cd.toString('utf8', p + 46, p + 46 + nameLength);
      // Zip64 sizes replace the 0xffffffff placeholders, in this order.
      for (let e = p + 46 + nameLength, end = e + extraLength; e + 4 <= end;) {
        const id = cd.readUInt16LE(e);
        const length = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressed === 0xffffffff) { uncompressed = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compressed === 0xffffffff) { compressed = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + length;
      }
      p += 46 + nameLength + extraLength + commentLength;
      const type = name.endsWith('/') || (mode & S_IFMT) === S_IFDIR ? 'directory'
        : (mode & S_IFMT) === S_IFLNK ? 'symlink' : 'file';
      if (type !== 'directory') entries.push({ name: name.replace(/\/$/, ''), type, size: uncompressed });
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

/** The zip entries that belong in dist: install.js moves the type definitions out of it. */
export function distEntries(zipPath) {
  return readZipEntries(zipPath).filter(entry => entry.name !== 'electron.d.ts');
}

/** Problems that make `distDir` differ from `entries` (missing/truncated files, missing links). */
export function verifyDist(distDir, entries) {
  const problems = [];
  const root = resolve(distDir) + sep;
  for (const entry of entries) {
    const path = resolve(distDir, entry.name);
    if (!path.startsWith(root)) { problems.push(`${entry.name}: outside dist`); continue; }
    let stat;
    try { stat = lstatSync(path); } catch { problems.push(`${entry.name}: missing`); continue; }
    if (entry.type === 'symlink') {
      if (!stat.isSymbolicLink()) problems.push(`${entry.name}: not a symlink`);
    } else if (!stat.isFile()) {
      problems.push(`${entry.name}: not a file`);
    } else if (stat.size !== entry.size) {
      problems.push(`${entry.name}: ${stat.size} bytes, expected ${entry.size}`);
    }
    if (problems.length >= 10) break;
  }
  return problems;
}

export function platformPath(platform) {
  switch (platform) {
    case 'mas':
    case 'darwin': return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux': return 'electron';
    case 'win32': return 'electron.exe';
    default: throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}

// Same target selection as electron/install.js.
function target(env = process.env) {
  const platform = env.ELECTRON_INSTALL_PLATFORM || env.npm_config_platform || process.platform;
  let arch = env.ELECTRON_INSTALL_ARCH || env.npm_config_arch || process.arch;
  if (platform === 'darwin' && process.platform === 'darwin' && arch === 'x64' && env.npm_config_arch === undefined) {
    const translated = spawnSync('sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8' });
    if (translated.stdout?.trim() === '1') arch = 'arm64';
  }
  return { platform, arch };
}

async function lock(dir, { timeoutMs = 15 * 60_000, log }) {
  const path = join(dir, '.stoneforge-ensure.lock');
  const started = Date.now();
  let announced = false;
  for (;;) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'pid'), String(process.pid));
      return () => rmSync(path, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let owner = NaN;
    try { owner = Number(readFileSync(join(path, 'pid'), 'utf8')); } catch {}
    let alive = false;
    if (Number.isInteger(owner) && owner > 0) {
      try { process.kill(owner, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
    } else {
      alive = Date.now() - started < 5_000; // The owner may not have written its pid yet.
    }
    if (!alive) { rmSync(path, { recursive: true, force: true }); continue; }
    if (!announced) { log(`[ensure-electron] waiting for another install (pid ${owner || 'unknown'})`); announced = true; }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${path}`);
    await sleep(250);
  }
}

/**
 * Makes `electronDir/dist` a complete, verified Electron install. `download()` returns the
 * checksum-verified release zip; `install()` runs Electron's install.js. Both are injectable.
 */
export async function ensureElectron({ electronDir, download, install, probe, platform = process.platform, log = console.log }) {
  const { version } = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8'));
  const executable = platformPath(platform);
  const dist = join(electronDir, 'dist');
  const manifestPath = join(dist, MANIFEST);
  const pathFile = join(electronDir, 'path.txt');
  const unlock = await lock(electronDir, { log });
  try {
    const installed = () => {
      try {
        return readFileSync(join(dist, 'version'), 'utf8').replace(/^v/, '').trim() === version
          && readFileSync(pathFile, 'utf8') === executable;
      } catch { return false; }
    };
    let result = 'verified';
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch {}
    const cached = manifest?.version === version && manifest.executable === executable && installed()
      && verifyDist(dist, manifest.entries).length === 0;
    if (!cached) {
      const zip = await download();
      const entries = distEntries(zip);
      if (!entries.some(entry => entry.name === executable)) throw new Error(`${zip} has no ${executable}`);
      let problems = installed() ? verifyDist(dist, entries) : ['not installed'];
      if (problems.length) {
        log(`[ensure-electron] Electron ${version} dist is incomplete (${problems.slice(0, 3).join('; ')}); reinstalling once`);
        rmSync(dist, { recursive: true, force: true });
        rmSync(pathFile, { force: true });
        install();
        result = 'installed';
        problems = installed() ? verifyDist(dist, entries) : ['install.js did not write dist/version and path.txt'];
        if (problems.length) throw new Error(`Electron ${version} install is still incomplete: ${problems.join('; ')}`);
      }
      manifest = { version, executable, entries };
      writeFileSync(manifestPath, JSON.stringify(manifest) + '\n');
    }
    probe?.(join(dist, executable), version);
    const bytes = manifest.entries.reduce((sum, entry) => sum + entry.size, 0);
    log(`[ensure-electron] Electron ${version} ${result}${cached ? ' (stored manifest)' : ' against the release zip'}: ${manifest.entries.length} files, ${bytes} bytes, ${join(dist, executable)}`);
    return result;
  } finally {
    unlock();
  }
}

// The binary must start: a truncated Electron Framework fails here (dyld), not later in a test.
export function probeElectron(executablePath, version) {
  const result = spawnSync(executablePath, ['-p', 'process.versions.electron'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000,
  });
  if (result.status !== 0 || result.stdout.trim() !== version) {
    throw new Error(`Electron ${executablePath} did not start (status ${result.status}, signal ${result.signal}): ${result.error?.message ?? ''}${result.stderr}`);
  }
}

async function main() {
  const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  // Resolve package.json only: requiring `electron` itself would start the lazy download.
  const electronDir = dirname(createRequire(join(desktop, 'package.json')).resolve('electron/package.json'));
  const electronRequire = createRequire(join(electronDir, 'package.json'));
  const { version } = electronRequire('./package.json');
  const { platform, arch } = target();
  const download = async () => {
    const { downloadArtifact } = await import(pathToFileURL(electronRequire.resolve('@electron/get')).href);
    return downloadArtifact({
      version, artifactName: 'electron', platform, arch,
      force: process.env.force_no_cache === 'true',
      cacheRoot: process.env.electron_config_cache,
      checksums: process.env.electron_use_remote_checksums || process.env.npm_config_electron_use_remote_checksums
        ? undefined : electronRequire('./checksums.json'),
    });
  };
  const install = () => {
    const result = spawnSync(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`electron/install.js failed (status ${result.status}, signal ${result.signal})`);
  };
  // Only the host's own binary can be started; Linux needs no display for ELECTRON_RUN_AS_NODE,
  // but may lack Chromium's shared libraries, which no Linux check uses.
  const probe = platform === 'darwin' && process.platform === 'darwin' ? probeElectron : undefined;
  await ensureElectron({ electronDir, download, install, probe, platform });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[ensure-electron] ${error.stack ?? error}`); process.exit(1); });
}
