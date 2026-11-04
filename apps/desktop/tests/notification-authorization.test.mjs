import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IDENTITIES } from '../scripts/app-identity.mjs';
import {
  NOTIFICATION_DEBUG_ENV, authorizationLog, authorizationVerdict, foreignResponsible, historyTimeoutMessage,
  launchContext, notAuthorizedError, parseAuthorizationLog, processAncestry, responsibleAppFromAncestry, setupHint,
} from '../scripts/notification-authorization.mjs';
import {
  LAUNCH_ENV, OPEN, launchMode, matchingProcesses, openArguments, writeLaunchServicesWrapper,
} from '../scripts/launch-services-launcher.mjs';

// Unit level only (el-3q8efw): fixed Electron log lines, process tables and event observations.
// Nothing here launches an app, runs `open`, asks macOS for notification authorization or
// answers a privacy prompt.
const desktop = resolve(import.meta.dirname, '..');
const app = '/tmp/stoneforge-check/Stoneforge Desktop Dev.app';
const dev = { app, ...IDENTITIES.dev };
const notAllowed = 'Notifications are not allowed for this application';
const preview = '/Applications/Stoneforge Desktop Preview.app';
// Process tree of an agent session in the installed app (observed 2026-11-04, paths anonymized).
const agentAncestry = [
  { pid: 400, command: '/bin/zsh' },
  { pid: 300, command: '/opt/homebrew/bin/claude' },
  { pid: 200, command: preview + '/Contents/Resources/runtime/node' },
  { pid: 100, command: preview + '/Contents/MacOS/Stoneforge Desktop' },
];
const describe = (path) => (path === preview ? { ...IDENTITIES.production } : { bundleId: 'com.example.other', productName: 'Other' });
const underPreview = launchContext({ mode: 'direct', ancestry: agentAncestry, describe });
const launchServices = launchContext({ mode: 'launchservices', ancestry: agentAncestry, describe });

test('parses Electron debug-notification authorization lines; the last result wins', () => {
  assert.deepEqual(parseAuthorizationLog(''), { state: 'unknown' });
  assert.deepEqual(parseAuthorizationLog('[1:INFO:notification_presenter_mac.mm(42)] Notification authorization granted: 1\n'), { state: 'granted', detail: 'granted: 1' });
  assert.deepEqual(parseAuthorizationLog('Notification authorization granted: 0'), { state: 'denied', detail: 'granted: 0' });
  assert.deepEqual(parseAuthorizationLog('noise\nError requesting notification authorization: ' + notAllowed + '\nmore'), { state: 'error', detail: notAllowed });
  assert.equal(parseAuthorizationLog('Notification authorization granted: 0\nNotification authorization granted: 1').state, 'granted');
  assert.equal(parseAuthorizationLog('Notification authorization granted: 1\nError requesting notification authorization: x').state, 'error');
});

test('collects split stderr/stdout chunks of the launched app', () => {
  const child = { stderr: new EventEmitter(), stdout: new EventEmitter() };
  const log = authorizationLog();
  log.attach(child);
  child.stderr.emit('data', Buffer.from('Notification authorization gran'));
  assert.equal(log.result().state, 'unknown');
  child.stderr.emit('data', Buffer.from('ted: 0\n'));
  assert.deepEqual(log.result(), { state: 'denied', detail: 'granted: 0' });
  log.attach(undefined); // a launch without a process handle must not throw
});

test('finds the likely responsible app in the process ancestry', () => {
  assert.deepEqual(responsibleAppFromAncestry(agentAncestry), { pid: 100, app: preview });
  // A helper app inside a bundle counts as the outer bundle.
  assert.deepEqual(responsibleAppFromAncestry([{ pid: 7, command: preview + '/Contents/Frameworks/Stoneforge Desktop Helper.app/Contents/MacOS/Stoneforge Desktop Helper' }]), { pid: 7, app: preview });
  assert.equal(responsibleAppFromAncestry([{ pid: 5, command: '/bin/zsh' }, { pid: 2, command: '/usr/sbin/sshd' }]), null);
  const table = { 400: '300 /bin/zsh', 300: '200 /opt/homebrew/bin/claude', 200: '1 /usr/sbin/sshd' };
  assert.deepEqual(processAncestry(400, (args) => table[args.at(-1)] ?? ''), [
    { pid: 400, command: '/bin/zsh' }, { pid: 300, command: '/opt/homebrew/bin/claude' }, { pid: 200, command: '/usr/sbin/sshd' },
  ]);
  assert.deepEqual(underPreview.responsible, { pid: 100, app: preview, ...IDENTITIES.production });
  assert.equal(foreignResponsible(dev, underPreview), true);
  assert.equal(foreignResponsible({ ...IDENTITIES.production }, underPreview), false, 'same identity as the responsible app');
  assert.equal(foreignResponsible(dev, launchServices), false, 'LaunchServices launches are their own responsible process');
  assert.equal(foreignResponsible(dev, launchContext({ mode: 'direct', ancestry: [], describe })), false);
  assert.deepEqual(launchContext({ mode: 'direct', ancestry: agentAncestry, describe: () => { throw new Error('no plist'); } }).responsible, { pid: 100, app: preview });
});

test('a definite refusal fails fast with the identity and what makes authorization work', () => {
  for (const observations of [
    { failures: [notAllowed] },
    { authorization: { state: 'denied', detail: 'granted: 0' } },
    { authorization: { state: 'error', detail: notAllowed }, shown: true },
  ]) {
    assert.equal(authorizationVerdict(observations).authorized, false);
    const error = notAuthorizedError(dev, observations, launchServices);
    assert(error instanceof Error);
    assert.match(error.message, /^Notifications are not authorized for ai\.stoneforge\.desktop\.dev \("Stoneforge Desktop Dev"\)/);
    assert.match(error.message, /launched the app through LaunchServices/);
    assert.match(error.message, /"Stoneforge Desktop Dev" \(ai\.stoneforge\.desktop\.dev\) must be allowed in System Settings > Notifications/);
    assert.match(error.message, /a person at the Mac must click Allow \(agents never answer it\)/);
    assert.doesNotMatch(error.message, /lsregister -f "/, 'lsregister -f is not presented as the setup');
  }
  assert.match(notAuthorizedError(dev, { failures: [notAllowed] }, launchServices).message, new RegExp('rejected the notification: ' + notAllowed));
});

test('reported authorization never fails early and keeps the plain delivered-history timeout', () => {
  const granted = { authorization: { state: 'granted', detail: 'granted: 1' }, shown: true, failures: [] };
  assert.deepEqual(authorizationVerdict(granted), { authorized: true });
  for (const context of [underPreview, launchServices, undefined]) {
    assert.equal(notAuthorizedError(dev, granted, context), null);
    const message = historyTimeoutMessage(dev, granted, context);
    assert.equal(message, 'macOS delivered history (show event yes, failed events 0, authorization granted)');
  }
});

test('a direct launch under another app names the responsible app and the LaunchServices rerun on timeout', () => {
  for (const observations of [{}, { shown: true }]) {
    assert.equal(authorizationVerdict(observations).authorized, undefined);
    assert.equal(notAuthorizedError(dev, observations, underPreview), null, 'unknown authorization must not shorten the history wait');
    const message = historyTimeoutMessage(dev, observations, underPreview);
    assert.match(message, /^macOS delivered history \(show event (yes|no), failed events 0, authorization unknown\)\. Notification authorization unconfirmed for ai\.stoneforge\.desktop\.dev/);
    assert(message.includes('launched the app directly from a process tree of "Stoneforge Desktop" (ai.stoneforge.desktop, pid 100)'), message);
    assert.match(message, /also after lsregister -f/);
    assert.match(message, /Rerun with DESKTOP_ATTENTION_LAUNCH=launchservices/);
    assert(message.includes(setupHint(dev, underPreview)));
  }
  // Not under a foreign app: no attribution claim, still the LaunchServices route.
  const plain = historyTimeoutMessage(dev, {}, launchContext({ mode: 'direct', ancestry: [], describe }));
  assert.doesNotMatch(plain, /process tree of/);
  assert.match(plain, /Rerun with DESKTOP_ATTENTION_LAUNCH=launchservices/);
  assert.doesNotMatch(historyTimeoutMessage(dev, {}, launchServices), /Rerun with|process tree of/);
});

test('launch mode and LaunchServices wrapper arguments', async () => {
  assert.equal(LAUNCH_ENV, 'DESKTOP_ATTENTION_LAUNCH');
  assert.equal(launchMode({}), 'direct');
  assert.equal(launchMode({ DESKTOP_ATTENTION_LAUNCH: 'LaunchServices' }), 'launchservices');
  assert.throws(() => launchMode({ DESKTOP_ATTENTION_LAUNCH: 'open' }), /must be one of direct, launchservices/);
  assert.equal(OPEN, '/usr/bin/open');
  assert.deepEqual(openArguments({ bundle: app, stdout: '/t/o.log', stderr: '/t/e.log', env: { PATH: '/usr/bin:/bin', A: 'x=y z' }, args: ['--inspect=0', '--project=/t/Проект x'] }), [
    '-n', '-W', '--stdout', '/t/o.log', '--stderr', '/t/e.log', '--env', 'PATH=/usr/bin:/bin', '--env', 'A=x=y z', app, '--args', '--inspect=0', '--project=/t/Проект x',
  ]);
  const dir = await mkdtemp(join(tmpdir(), "launch-wrapper-'q-"));
  try {
    const wrapper = writeLaunchServicesWrapper({ dir, bundle: app, executable: app + '/Contents/MacOS/Stoneforge Desktop Dev', forwardEnv: ['PATH'], node: '/opt/node 22/bin/node' });
    assert.equal((await stat(wrapper)).mode & 0o111, 0o111, 'executable');
    const script = await readFile(wrapper, 'utf8');
    assert.match(script, /^#!\/bin\/sh\nexec '\/opt\/node 22\/bin\/node' '[^']*launch-services-launcher\.mjs' '.*launch-wrapper-'\\''q-.*\/launch-services\.json' "\$@"\n$/);
    const config = JSON.parse(await readFile(join(dir, 'launch-services.json'), 'utf8'));
    assert.deepEqual({ ...config, stdout: undefined, stderr: undefined }, { bundle: app, executable: app + '/Contents/MacOS/Stoneforge Desktop Dev', forwardEnv: ['PATH'], stdout: undefined, stderr: undefined });
  } finally { await rm(dir, { recursive: true, force: true }); }
  const ps = [
    '  11 /private/tmp/x/Dev.app/Contents/MacOS/Dev --inspect=0 --project=/tmp/run/a --project=/tmp/run/b',
    '  12 /private/tmp/x/Dev.app/Contents/MacOS/Dev --project=/tmp/other/a',
    '  13 /Applications/Stoneforge Desktop Preview.app/Contents/MacOS/Stoneforge Desktop --project=/tmp/run/a',
  ].join('\n');
  assert.deepEqual(matchingProcesses(ps, ['/tmp/x/Dev.app/Contents/MacOS/Dev', '/private/tmp/x/Dev.app/Contents/MacOS/Dev'], ['--project=/tmp/run/a']), [11]);
});

test('check-attention launches with debug logging, its own bundle ID and checks authorization before the history timeout', async () => {
  assert.deepEqual({ ...NOTIFICATION_DEBUG_ENV }, { ELECTRON_DEBUG_NOTIFICATIONS: '1', ELECTRON_ENABLE_LOGGING: '1' });
  const source = await readFile(join(desktop, 'scripts/check-attention.mjs'), 'utf8');
  assert.match(source, /const appEnv=\{\.\.\.NOTIFICATION_DEBUG_ENV,[^\n]*__CFBundleIdentifier:bundleId\}/);
  assert.match(source, /context\.mode==='launchservices'\n\s*\? writeLaunchServicesWrapper\(/);
  assert.match(source, /_electron\.launch\(\{executablePath,args,env:\{\.\.\.env,\.\.\.appEnv\}/);
  assert.match(source, /authLog\.attach\(electron\.process\(\)\)/);
  assert.match(source, /this\.on\('failed'/);
  // The delivered-history assertion keeps its 30 s budget; refusal is checked inside that wait.
  const wait = source.slice(source.indexOf('for(const deadline=Date.now()+30_000;;)'));
  assert(wait.length < source.length, 'history wait loop present');
  assert(wait.indexOf('Notification.getHistory()') < wait.indexOf('notAuthorizedError(identity,observed,context)'));
  assert(wait.indexOf('notAuthorizedError(identity,observed,context)') < wait.indexOf('historyTimeoutMessage(identity,observed,context)'));
});
