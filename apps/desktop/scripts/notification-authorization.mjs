/**
 * macOS notification authorization of the app identity under test (el-3q8efw).
 *
 * check-attention requires the native attention notification to appear in Notification
 * Center history (`Notification.getHistory()`). macOS only delivers it when notifications are
 * authorized for the app. A new identity such as the dev package `ai.stoneforge.desktop.dev`
 * (el-4fxwb9) has no Notification Center entry until the app's own authorization request is
 * answered. On 2026-11-04 (el-wyqc39, el-3ycnq7) check-attention launched the dev package
 * directly from an agent session: no prompt appeared, no "Stoneforge Desktop Dev" entry was
 * created and the history wait timed out, also after `lsregister -f`. Such a launch is a child of
 * the installed Stoneforge Desktop (its "Responsible Process" in crash reports) and inherits
 * `__CFBundleIdentifier=ai.stoneforge.desktop`, so macOS attributes the request to that app, not
 * to the dev identity. A LaunchServices launch (`DESKTOP_ATTENTION_LAUNCH=launchservices`, see
 * launch-services-launcher.mjs) starts the app as its own responsible process.
 *
 * Electron 44 exposes two runtime signals, both read-only (nothing here asks for or answers a
 * permission):
 *   - Notification 'failed' (darwin): UNUserNotificationCenter rejected addNotificationRequest,
 *     e.g. "Notifications are not allowed for this application"; 'show' means it was accepted.
 *   - With ELECTRON_DEBUG_NOTIFICATIONS (and Chromium logging on stderr) Electron logs the
 *     result of its own requestAuthorization call: "Notification authorization granted: 0|1"
 *     or "Error requesting notification authorization: <description>".
 * This module turns those observations and the launch context into a verdict and an actionable
 * message; the check fails fast on a definite refusal and keeps the full delivered-history wait
 * otherwise.
 */
import { execFileSync } from 'node:child_process';
import { LAUNCH_ENV } from './launch-services-launcher.mjs';

/** Launch environment that makes Electron log its notification authorization result to stderr. */
export const NOTIFICATION_DEBUG_ENV = Object.freeze({ ELECTRON_DEBUG_NOTIFICATIONS: '1', ELECTRON_ENABLE_LOGGING: '1' });

/**
 * Nearest app bundle among a process and its ancestors, given as rows { pid, command } from the
 * process up to launchd. Responsibility is inherited across fork/exec unless a parent disclaims
 * it (not observable without root: `launchctl procinfo` needs it), so this is the likely
 * responsible app. Helper apps inside a bundle count as the outer bundle.
 */
export function responsibleAppFromAncestry(rows) {
  const appOf = (command) => String(command).match(/^(\/.*?\.app)\/Contents\//)?.[1];
  const index = rows.findIndex(({ command }) => appOf(command));
  if (index < 0) return null;
  const app = appOf(rows[index].command);
  // Report the bundle's outermost process in this chain (normally its main executable).
  let last = index;
  while (last + 1 < rows.length && appOf(rows[last + 1].command) === app) last++;
  return { pid: rows[last].pid, app };
}

/** Process ancestry of `pid` via ps (read-only), nearest first. */
export function processAncestry(pid = process.pid, ps = (args) => execFileSync('/bin/ps', args, { encoding: 'utf8' })) {
  const rows = [];
  for (let current = pid, guard = 0; current > 1 && guard < 64; guard++) {
    const line = ps(['-o', 'ppid=,comm=', '-p', String(current)]).trim();
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match) break;
    rows.push({ pid: current, command: match[2] });
    current = Number(match[1]);
  }
  return rows;
}

/**
 * Launch context of check-attention: mode ('direct' | 'launchservices') and the likely
 * responsible app of the check itself ({ pid, app, bundleId, productName } or null).
 */
export function launchContext({ mode, ancestry = processAncestry(), describe }) {
  const found = responsibleAppFromAncestry(ancestry);
  let responsible = null;
  if (found) {
    try { responsible = { ...found, ...describe(found.app) }; } catch { responsible = { ...found }; }
  }
  return { mode, responsible };
}

/** True when a direct launch runs under another app, which then owns the notification request. */
export function foreignResponsible(identity, context) {
  return context?.mode === 'direct' && Boolean(context.responsible) && context.responsible.bundleId !== identity.bundleId;
}

const GRANTED = /Notification authorization granted: (\S+)/g;
const REQUEST_ERROR = /Error requesting notification authorization: ([^\r\n]*)/g;

/**
 * Authorization result from Electron's debug log text (the last result wins).
 * Returns { state: 'granted' | 'denied' | 'error' | 'unknown', detail? }.
 */
export function parseAuthorizationLog(text) {
  let last;
  for (const match of String(text).matchAll(GRANTED)) {
    const value = match[1].toLowerCase();
    last = { index: match.index, state: ['1', 'true', 'yes'].includes(value) ? 'granted' : 'denied', detail: 'granted: ' + match[1] };
  }
  for (const match of String(text).matchAll(REQUEST_ERROR)) {
    if (!last || match.index > last.index) last = { index: match.index, state: 'error', detail: match[1].trim() };
  }
  return last ? { state: last.state, detail: last.detail } : { state: 'unknown' };
}

/** Collects stderr/stdout chunks of the launched app and reports the authorization result. */
export function authorizationLog() {
  let text = '';
  return {
    write(chunk) { text = (text + String(chunk)).slice(-262_144); },
    attach(child) {
      for (const stream of [child?.stderr, child?.stdout]) stream?.on('data', (chunk) => this.write(chunk));
    },
    result() { return parseAuthorizationLog(text); },
  };
}

/**
 * What makes authorization work for the identity, as shown in the failure message and the README.
 * `lsregister -f` plus System Settings is not presented as sufficient: it did not create an
 * entry for a directly launched dev package (2026-11-04).
 */
export function setupHint({ bundleId, productName }, context) {
  const who = '"' + productName + '" (' + bundleId + ')';
  const owner = context?.responsible;
  const foreign = foreignResponsible({ bundleId }, context)
    ? 'This run launched the app directly from a process tree of "' + (owner.productName ?? owner.app) + '" (' + (owner.bundleId ?? 'unknown bundle ID')
      + ', pid ' + owner.pid + '), which macOS treats as the responsible app, so the notification request is not attributed to ' + bundleId
      + ' (observed 2026-11-04: no prompt, no Notification Center entry and no delivered history, also after lsregister -f). '
    : '';
  const launch = context?.mode === 'launchservices'
    ? 'This run launched the app through LaunchServices (' + LAUNCH_ENV + '=launchservices). '
    : 'Rerun with ' + LAUNCH_ENV + '=launchservices so LaunchServices starts the app as its own responsible process. ';
  return foreign + launch
    + 'Authorization for ' + who + ' comes from the app\'s own first notification request: on that run macOS shows its notification prompt and a person at the Mac must click Allow (agents never answer it); '
    + 'then ' + who + ' must be allowed in System Settings > Notifications. Never register or launch a production-identity copy for this. '
    + 'See apps/desktop/README.md, "Notification authorization".';
}

/**
 * Verdict from the observations of one emitted notification:
 *   failures       'failed' event errors of that notification
 *   shown          whether its 'show' event fired (macOS accepted the request)
 *   authorization  parseAuthorizationLog() result
 * Returns { authorized: false, reason } for a definite refusal, { authorized: true } when macOS
 * reported authorization, else { authorized: undefined, reason } (no answer yet).
 */
export function authorizationVerdict({ failures = [], shown = false, authorization = { state: 'unknown' } } = {}) {
  if (authorization.state === 'denied') return { authorized: false, reason: 'macOS answered Electron\'s authorization request with ' + authorization.detail };
  if (authorization.state === 'error') return { authorized: false, reason: 'Electron\'s authorization request failed: ' + authorization.detail };
  if (failures.length) return { authorized: false, reason: 'Notification Center rejected the notification: ' + failures.join('; ') };
  if (authorization.state === 'granted') return { authorized: true };
  return { authorized: undefined, reason: shown
    ? 'macOS accepted the notification request but reported no authorization result'
    : 'macOS reported neither delivery nor authorization (an unanswered notification prompt, or a request attributed to another app)' };
}

/** Error for a definite refusal, or null. */
export function notAuthorizedError(identity, observations, context) {
  const verdict = authorizationVerdict(observations);
  if (verdict.authorized !== false) return null;
  return new Error('Notifications are not authorized for ' + identity.bundleId + ' ("' + identity.productName + '"): '
    + verdict.reason + '. ' + setupHint(identity, context));
}

/**
 * Message for a delivered-history timeout. With reported authorization the plain timeout stays
 * (a real delivery failure); otherwise it names the missing authorization and the setup.
 */
export function historyTimeoutMessage(identity, observations, context) {
  const verdict = authorizationVerdict(observations);
  const observed = 'show event ' + (observations?.shown ? 'yes' : 'no') + ', failed events ' + (observations?.failures?.length ?? 0)
    + ', authorization ' + (observations?.authorization?.state ?? 'unknown');
  if (verdict.authorized === true) return 'macOS delivered history (' + observed + ')';
  return 'macOS delivered history (' + observed + '). ' + (verdict.authorized === false ? 'Notifications are not authorized' : 'Notification authorization unconfirmed')
    + ' for ' + identity.bundleId + ' ("' + identity.productName + '"): ' + verdict.reason + '. ' + setupHint(identity, context);
}
