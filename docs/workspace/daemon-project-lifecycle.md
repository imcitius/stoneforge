# Project startup and task processing — el-5frvr5

## Incident finding (2026-11-02)

The retained Stoneforge Desktop project log contains two server startup segments,
both reporting `Dispatch daemon auto-start disabled (DAEMON_AUTO_START=false)`.
The latest segment precedes the reported manual daemon start and subsequent task
recovery. The installed build metadata identifies d58bd815; its bundled
`server/managed.js` sets both `DAEMON_AUTO_START=false` and `autoStartDaemon:false`.
That managed-start override explains the daemon remaining off on project start,
independently of the saved preference. The logs have no request audit trail or
retained `was stopped by user` startup line. They cannot establish who previously
called `/api/daemon/stop`, or whether the overwritten state was false. No external
stop is claimed as the actual trigger of this incident.

A separate confirmed source defect existed in Desktop's external-server Stop:
it called the default persisting daemon-stop endpoint. Stop, Restart, Remove and
Quit all reach this path. The managed shutdown path and server `close()` stop
services without writing the preference. CLI and dashboard daemon stop call the
persisting endpoint deliberately. No other active production `saveDaemonState(false)`
caller was found. The development app entry point imports the package server;
its unused duplicate daemon HTTP route and barrel export were removed.

## Contract

- Explicit Desktop Start Project starts processing for managed and adopted servers,
  unless `daemon-state.json` records `shouldRun:false, updatedBy:'user'`.
  Selecting a tab still never starts anything. Standalone `DAEMON_AUTO_START=false`
  remains supported; Desktop Start is an explicit request and uses the preference.
- Server/project shutdown does not rewrite that preference. HTTP daemon stop still
  persists by default; `?persist=false` stops transiently. Status advertises
  `supportsTransientStop` and `pausedByUser`.
- Desktop uses transient stop for current external servers. Older servers without
  that capability receive graceful SIGTERM, avoiding their persisting stop API.
  External Stop waits for the verified process to exit (up to 46 seconds), not just
  its listening socket to close, before allowing a restart.
  Older status responses are supplemented by reading their workspace's saved
  preference before starting processing; Desktop never rewrites it directly.
- A stopped available daemon appears as **Task processing paused** in Desktop;
  the tab menu offers **Task processing paused — Resume**. Status polls every
  three seconds. Unavailable daemons are not misrepresented as resumable pauses.
  A Director input request retains status priority; Resume remains in the menu.
- Resume/start/stop preserve daemon configuration overrides. Server startup no
  longer rewrites saved state. Historical user stops are not automatically migrated:
  old shutdown-generated stops cannot be distinguished from genuine user choices.

## Regression coverage

`apps/desktop/tests/daemon-lifecycle.test.mjs` uses real temporary backends and CLI
pause commands, with managed, external and legacy-status variants. It checks
initial startup, adoption of a paused server, stop/start, exact preference retention,
Resume, config retention, menu/status visibility and Remove. Legacy fixtures omit
capability fields and reject any HTTP daemon-stop attempt. External fixtures delay
process exit after socket closure to prove Stop waits for complete shutdown. The external discovery
test also checks starting a server previously launched with auto-start disabled.
The isolation test explicitly pauses its manually assigned task fixture to prevent
real provider dispatch now that project start enables the daemon.

`packages/smithy/src/server/daemon-lifecycle.bun.test.ts` verifies default/persisted
preference semantics, transient stop, status and config retention in a subprocess
with its own temporary cwd. The packaged `check-app.mjs` additionally checks the
visible paused status and the actual Resume menu handler before creating tasks.

Verification results are recorded in workspace documents el-1uyc and el-3hu3f1.
Raw logs, generated app bundles and machine paths are not stored in the repository.
