#!/usr/bin/env node
/**
 * Launch a packaged app through macOS LaunchServices for Playwright (el-3q8efw).
 *
 * Playwright's `_electron.launch` spawns `executablePath` itself, so the app becomes a child of
 * the check and inherits the check's "responsible process": in an agent session that is the
 * installed Stoneforge Desktop (crash reports of such launches name it as "Responsible Process").
 * macOS attributes privacy decisions to that responsible app, and on 2026-11-04 a directly
 * launched dev identity (`ai.stoneforge.desktop.dev`) never received a Notification Center entry,
 * prompt or delivered history, even after `lsregister -f`.
 *
 * `writeLaunchServicesWrapper()` writes a small executable for `executablePath`. Playwright runs
 * it with its usual arguments (`--inspect=0 --remote-debugging-port=0 ...`); the wrapper runs
 * `/usr/bin/open -n -W` so launchd starts the bundle as its own responsible process, and relays
 * the app's stdout/stderr files to its own streams, where Playwright reads the "Debugger
 * listening" / "DevTools listening" lines and connects to the app as usual. The wrapper exits
 * when the app exits and kills the app when it is terminated itself.
 */
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, openSync, realpathSync, readFileSync, readSync, fstatSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPEN = '/usr/bin/open';
/** check-attention launch mode: `direct` (Playwright spawns the executable) or `launchservices`. */
export const LAUNCH_ENV = 'DESKTOP_ATTENTION_LAUNCH';
export const LAUNCH_MODES = Object.freeze(['direct', 'launchservices']);

export function launchMode(env = process.env) {
  const mode = (env[LAUNCH_ENV] || 'direct').toLowerCase();
  if (!LAUNCH_MODES.includes(mode)) throw new Error(LAUNCH_ENV + ' must be one of ' + LAUNCH_MODES.join(', ') + ', not ' + JSON.stringify(env[LAUNCH_ENV]));
  return mode;
}

/**
 * Arguments for `/usr/bin/open`: a new instance (-n), waiting for it to exit (-W), with its
 * stdio in files and the given variables set explicitly (LaunchServices may replace some of the
 * forwarded environment, e.g. PATH), followed by the app's own arguments.
 */
export function openArguments({ bundle, stdout, stderr, env = {}, args = [] }) {
  return ['-n', '-W', '--stdout', stdout, '--stderr', stderr,
    ...Object.entries(env).flatMap(([key, value]) => ['--env', key + '=' + value]),
    bundle, '--args', ...args];
}

const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";

/**
 * Writes `<dir>/launch-services-electron.sh` and its configuration; returns the wrapper path to
 * use as Playwright's `executablePath`. `forwardEnv` lists the variables passed with `--env`.
 */
export function writeLaunchServicesWrapper({ dir, bundle, executable, forwardEnv = [], node = process.execPath }) {
  const config = join(dir, 'launch-services.json');
  writeFileSync(config, JSON.stringify({ bundle, executable, forwardEnv, stdout: join(dir, 'app-stdout.log'), stderr: join(dir, 'app-stderr.log') }, null, 2) + '\n');
  const wrapper = join(dir, 'launch-services-electron.sh');
  writeFileSync(wrapper, '#!/bin/sh\nexec ' + [node, fileURLToPath(import.meta.url), config].map(shellQuote).join(' ') + ' "$@"\n');
  chmodSync(wrapper, 0o755);
  return wrapper;
}

/**
 * PIDs of running `executable` processes whose command line contains every marker. `executable`
 * may be a list (the path as given and its realpath: launchd reports /tmp as /private/tmp).
 */
export function matchingProcesses(psOutput, executable, markers) {
  const paths = [executable].flat();
  return String(psOutput).split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) return [];
    const command = match[2];
    return paths.some((path) => command.includes(path)) && markers.every((marker) => command.includes(marker)) ? [Number(match[1])] : [];
  });
}

/** Kills the app instances launched with these arguments (LaunchServices launches are not our children). */
export function killLaunched(executable, markers) {
  if (!markers.length) return; // never kill other instances of the same app
  const ps = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  let real = executable;
  try { real = realpathSync(executable); } catch {}
  for (const pid of matchingProcesses(ps, [executable, real], markers)) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

/** Copies what was appended to `file` since `offset` to `stream`; returns the new offset. */
function relay(file, offset, stream) {
  let fd;
  try { fd = openSync(file, 'r'); } catch { return offset; }
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return offset;
    const buffer = Buffer.alloc(size - offset);
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    stream.write(buffer.subarray(0, read));
    return offset + read;
  } finally { closeSync(fd); }
}

async function main([configPath, ...args]) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  for (const file of [config.stdout, config.stderr]) writeFileSync(file, '');
  const env = Object.fromEntries(config.forwardEnv.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  // Arguments that identify this instance among other copies of the same app.
  const markers = args.filter((arg) => !arg.startsWith('--inspect') && !arg.startsWith('--remote-debugging-port'));
  const open = spawn(OPEN, openArguments({ ...config, env, args }), { stdio: ['ignore', 'inherit', 'inherit'] });
  const offsets = { out: 0, err: 0 };
  const flush = () => {
    offsets.out = relay(config.stdout, offsets.out, process.stdout);
    offsets.err = relay(config.stderr, offsets.err, process.stderr);
  };
  const timer = setInterval(flush, 50);
  const stop = (code) => {
    clearInterval(timer); flush();
    if (code !== 0) { try { killLaunched(config.executable, markers); } catch {} }
    process.exit(code);
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { open.kill(); stop(1); });
  open.on('error', (error) => { process.stderr.write('open failed: ' + error.message + '\n'); stop(1); });
  open.on('exit', (code) => stop(code ?? 1));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2));
