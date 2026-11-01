# Director liveness and provider quota isolation

Implemented on 2026-10-02 from local master `d9869bcca9cf6d86a7c940fc9044d9f46766aabb`.

The dispatch daemon now reconciles idle running directors against ready unassigned
work and pending/failed merges. It nudges the owning director after two minutes of
inactivity and spaces attempts, including failed delivery, by the same interval.
Recent human input, disabled/stopped/suspended directors, manual sleep and that
provider's quota are respected. The normal worker and merge dispatch loops remain
the executors. See the public Auto-Dispatch guide for SDK options and limitations.

Quota attribution uses the session/agent provider, including custom executable
paths. Claude fallback wrappers remain compatible, but cannot be launched as a
Codex executable or pause a Codex agent. HTTP start/resume checks use the requested
agent. SessionManager forwards quota events from UI-created sessions as well as
sessions started by the daemon. Interactive terminal detection accepts supported
complete standalone banners and never renews a pause from the same historical
banner after Enter. Failed inbox delivery leaves the message unread.

Silent rapid exits and old session-history patterns no longer establish provider
quota evidence. In particular, repeated recovery polls cannot keep renewing the
same expired one-hour pause from unchanged history. Ordinary failures retain the
bounded retry/recovery-steward path.

## Verification

- Frozen pnpm install completed; lockfile unchanged.
- Final required `pnpm check:merge`, with the documented Desktop Node 22.23.3 on
  PATH: **192/192 checks passed**, exit 0, 232.20 seconds. This includes uncached
  workspace typechecking, Desktop build, isolated Bun suites, Smithy Node/Vitest
  (349 tests), and Desktop Node integration (6 tests).
- Relevant Bun suites within that gate: daemon **154 passed / 2 existing skips**,
  SessionManager **86 passed**, Spawner **75 passed**, terminal quota parser
  **3 passed**.
- Additional HTTP start/resume quota tests: **8/8 passed** under Node 22.23.3.
- Documentation site build: passed, 38 pages. `git diff --check`: passed.
- Independent read-only review caught and prompted fixes for per-agent Codex
  wrappers and terminal transcript replay; updated source had no blocking findings.

Final gate evidence is in
`$TMPDIR/stoneforge-merge-check-271LUn/results.json`.
The initial diagnostic gate is retained at the sibling `stoneforge-merge-check-3GPdj8`
folder: 190/192 passed. Both CLI failures used system Node 26.8.2 (ABI 147) with
SQLite built for Node 22 (ABI 127). A separate in-memory storage probe reproduced
the exact ABI mismatch; the same probe and complete final gate passed using the
repository's pinned Desktop runtime. No test thresholds or gate rules changed.

## Boundaries

This is source verification, not a live-provider or installed-app acceptance test.
The installed Desktop and shared workspace data were not updated. A running daemon
and running director session are required. Continuous terminal redraws can mask
inactivity. Unknown terminal layouts and repeated identical generic banners do not
prove fresh quota evidence; after expiry the normal watchdog interval applies.
Known reset-time parsing retains its existing 15-minute minimum, 24-hour maximum
and one-hour/six-hour fallback behavior. The watchdog does not bypass task
constraints, human approvals or manually suspended sessions.

## photo-cleanup recovery regression — 2026-10-04

Read-only inspection of the installed instance (build 2026-10-03T21:07:29.275Z)
confirmed this sequence, in Asia/Jerusalem time:

- 00:40:04: director `el-2ckq` ended its turn waiting for worker `el-5w32`.
- 00:40:57: worker session `96ae821c-1002-4b35-8737-7b8701e35bd9`
  received a synthetic Claude rejection: `You've hit your session limit`, with
  `error=rate_limit` and `quotaLimits.resetsAt=1791073800` (03:30 that morning).
  Its process exited; it had not sent a completion message. No such message
  existed in the live inbox or message table, so this was not a lost delivery.
- Task `el-usdqi` remained in progress and assigned to that worker. The local
  project controller disables workers after explicit starts, keeping automatic
  dispatch off. Orphan recovery correctly did not enable that worker.
- The running daemon had inbox forwarding enabled and no remaining limit by
  morning, but its director watchdog only considered unassigned ready tasks and
  reviews. It never considered this assigned, unfinished task with no executor.
  Director terminal activity stayed unchanged across diagnostic samples; continuous
  redraws are not established as a cause in this incident.

The watchdog now includes assigned open/in-progress tasks whose registered worker
or steward has no active session. It nudges the owning director to inspect the
outcome and follow project dispatch rules, without enabling/resuming the worker,
changing task ownership, or treating human assignments/suspended sessions as orphans.
Successful watchdog delivery is also logged in the ordinary backend log, even
when an operation-log service is not wired into the server.

Both headless and terminal quota recognition accept the session-limit wording.
For headless rejection envelopes, an absolute finite reset epoch takes precedence
over the clock-only banner. Rapid-exit recovery uses the same envelope, so it does
not overwrite the timestamp by rolling clock text to the next day. Existing
minimum/maximum pause bounds remain in place. Tool output and user text are not
accepted as headless quota evidence.

The initial incident regressions failed four tests on the prior implementation.
Focused coverage includes parked workers and quota expiry, starting/running
executors, human/suspended assignments, exact reset epochs, rapid-exit aliases,
terminal chunking and redraw deduplication. Full gate and exact artifact evidence
are recorded separately with the candidate; this source note does not claim an
installed update or live-agent recovery.

## Weekly quota watchdog loop — 2026-10-07

The reported `You've hit your weekly limit · resets Oct 9 at 2am
(Asia/Jerusalem)` banner was rejected by both the shared message detector and
standalone PTY banner detector: their optional qualifier accepted `session` and
`usage`, but not `weekly`. Consequently the watchdog had no recorded provider
limit and kept nudging the Claude director for orphaned task `el-14vx0` every two
minutes. The live photo-cleanup backend log confirmed these repeated nudges.

Both detectors now accept the weekly wording. The daemon's maximum reset horizon
is seven days instead of 24 hours, preserving an actual weekly reset beyond the
next day while still bounding malformed dates. Existing provider separation,
redraw deduplication, fallback durations and minimum floor remain unchanged.
The dated Jerusalem banner resolves to `2026-10-08T23:00:00Z`, i.e. October 9 at
02:00 local time. No provider calls were used to verify the change.

Before correction, new parser/terminal tests failed 2/2 and targeted daemon
regressions failed 2/2 (unrecognized banner and truncated reset). After correction,
parser/terminal coverage passed 62/62, daemon coverage passed 168 with two existing
skips, and Spawner coverage passed 77/77. Tests cover the exact message, curly
apostrophe, timezone, ANSI chunks, upgrade hints/echoes/redraws, headless events,
no watchdog delivery after 24 hours or immediately before the reset, and automatic
delivery after expiry. Full gate and packaged artifact results follow below.

Live mitigation: through the authenticated workspace API, only photo-cleanup's
`directorWatchdogEnabled` was set to `false`; the backend returned the applied
configuration with the correct project root. The daemon and director remain
running, and other dispatch/inbox settings are unchanged. This flag is in-memory
and returns to the configured/default value on backend restart. No installation,
session restart, message delivery, task mutation or direct SQLite write was used.
The original staged changes in this worktree were preserved; this fix is an
unstaged increment. Git author identity is still unconfigured, so no identity
was invented and no commit or merge is claimed.

Verification of the weekly-limit increment:

- Required `pnpm check:merge`, pinned Node 22.23.3 and pnpm 8.15.5: **192/192
  passed**, exit 0, 236.47s. Summary: `/tmp/stoneforge-weekly-gate.log`; detailed
  logs/results: `$TMPDIR/stoneforge-merge-check-EGn789`.
- `pnpm --filter @stoneforge/desktop package:mac`: exit 0, including bundled
  SQLite, portable links, actual PTY spawn/output/exit and code signature checks.
  Candidate: `apps/desktop/dist/mac/Stoneforge Desktop-darwin-arm64/Stoneforge Desktop.app`,
  build `2026-10-07T14:22:36.728Z`, base `d9869bc`, modified source.
- The three changed compiled modules were compared byte-for-byte between the
  tested workspace build and candidate bundle. A check using the candidate's
  bundled Node confirmed weekly message detection, PTY detection and the seven-day
  horizon. This candidate is not installed.
- After disabling the live watchdog, the project log remained at 395 watchdog
  entries across multiple former polling intervals; the daemon remained running.
- Packaged `check-app.mjs`: passed using temporary fixtures, including UI, Logs,
  onboarding, authenticated transports, repository selection and external backend
  adoption. Evidence: `/tmp/stoneforge-weekly-app.log`, fixture
  `$TMPDIR/stoneforge-electron-zRRjiQ`.
- Packaged `check-launch-services.mjs`: passed, including Unicode workspace path
  and backend cleanup after parent exit. Evidence: `/tmp/stoneforge-weekly-launch.log`.
  These checks did not launch paid provider sessions or restart live workspaces.


### Installed after explicit Human approval — 2026-10-07

At installation preflight the app and both backends had already exited; all
sessions were idle. No live session was interrupted or resumed. The installed
October 6 build contained socket workaround `a5b5fa2`, absent from the earlier
weekly-limit candidate. Its source/test plus startup import and packaging entry
were integrated into this worktree before packaging again. Desktop tests passed
15/15, including the pinned Electron EINVAL reproduction/control. The three
weekly-limit backend modules remained byte-identical to the full-gate build.

Final candidate built at `2026-10-07T20:54:12.133Z` (base `d9869bc`, modified)
was installed into `~/Applications/Stoneforge Desktop Preview.app`. Packaging,
native SQLite/PTY, code signing and LaunchServices checks passed. Initial packaged
UI check failed because Logs' native window lost focus; its log is retained.
One bounded repeat passed the full UI suite, including Logs, onboarding and
external backend adoption. This is not a claim that the intermittent focus
failure was fixed.

Verified backup and evidence:
`<backups-dir>/weekly-limit-20261007T205346Z`.
The backup contains the old app, userData, both project state directories excluding
unchanged `.worktrees`, and independently verified SQLite snapshots. Volatile
`*-shm` files were excluded from hash comparisons. Installation verified all 9034
candidate file/link entries; the original installed app was also retained.

Both real projects opened successfully from the installed app. Authenticated API
identity checks returned their correct roots and new backend PIDs 6534/6565,
whose executable/managed-server paths resolve inside the installed bundle.
The UI shows both projects ready and `v0.1.0 · d9869bcca9cf (modified)`.
Both session lists are empty and daemons stopped, preserving pre-install idle
state. All 964 Stoneforge and 928 photo-cleanup element payloads match the cold
backups; both databases pass integrity_check. No paid provider session was used.

## Wrapped Claude quota retry loop — 2026-10-11

The user reported watchdog retries while Claude displayed a session quota wait
until 16:30 Asia/Jerusalem. Live readback confirmed the October 7 installed build,
director session `session-muylowfi-0001-jj98`, daemon running and an empty quota
tracker. The watchdog was temporarily disabled through the authenticated
photo-cleanup API without interrupting the director.

A ten-second passive PTY subscription produced no output. A controlled resize
from the observed 48x49 geometry to 47x49 and back captured the actual redraw,
without sending terminal input or requesting model inference. It contains
carriage returns, ANSI cursor commands, a `⏺` automatic-retry status, a nested `⎿`
rejection whose first line ends in `resets`, the clock/timezone on the next line,
and a `⚠ Usage limit reached` footer. The old detector completed the first
rejection line early, used a one-hour fallback and deduplicated that incomplete
text for the session's lifetime, losing subsequent reset clocks. The weekly-word
fix did not address this terminal layout.

The terminal detector now joins narrowly recognized quota continuation lines,
accepts the actual status decorations, extracts the automatic-retry clock, and
waits for a reset continuation instead of recording an incomplete banner with a
fallback. Complete PTY lines are processed before bounding the unfinished tail,
so large redraw chunks no longer discard early banners. Explicit timezone clocks
win over generic footers within the same redraw. Full normalized banner text is
deduplicated; changing the reset clock produces new evidence while Enter/redraws
do not renew the same quota. Unrelated output abandons pending fragments.

Screenshot-layout regression baseline: 6 pass, 4 fail. Corrected terminal tests:
12/12, including an actual quota-only ANSI excerpt, individual-character chunking,
later reset clocks, echoed prompts and unrelated output. Daemon tests: 170 pass,
2 existing skips, including no watchdog delivery before the parsed reset and
resumption after it. Spawner tests: 77/77 with wrapped rejection events and redraw
suppression. The previous worktree staging and installed socket workaround are
preserved; no new Git identity is invented.

Required `pnpm check:merge` on the wrapped-quota correction passed **192/192**,
exit 0, 240.85s using pinned Node 22.23.3 / pnpm 8.15.5. Full results:
`$TMPDIR/stoneforge-merge-check-ltZzoV`;
summary `/tmp/stoneforge-terminal-retry-gate.log`. An isolated replay against the
saved previous detector additionally confirmed a wrong `13:08Z` fallback from
`12:08Z`, rather than the stated `13:30Z`, and suppression of a changed reset.

### Corrected installation and live quota acceptance — 2026-10-11

The packaged UI and LaunchServices checks passed on the first attempt for this
candidate. Final installed build: `2026-10-11T12:20:42.264Z`, base `d9869bc`, modified.
All 9034 installed file/link entries were verified against the candidate. Existing
socket workaround bytes were preserved. Backup/evidence directory:
`<backups-dir>/terminal-retry-20261011T122247Z`.
Both database backups pass integrity checks; code worktrees were outside the
installation mutation scope and excluded from the state-directory backup.

Both original director conversation IDs were retained. The photo-cleanup director
was already manually resumed while the UI was being reopened; that live session
was preserved, without a duplicate resume. Stoneforge's saved Codex conversation
was resumed through its API. Original daemon states/configuration were restored:
Stoneforge stopped; photo-cleanup running with its prior 30s poll and automatic
worker dispatch disabled. The temporary watchdog opt-out was removed and read back
as `directorWatchdogEnabled: true`.

Live acceptance: the new photo-cleanup backend recorded the observed Claude quota
as `2026-10-11T13:30:00.000Z` (16:30 Asia/Jerusalem). Both API and UI show dispatch
paused until that time. This evidence comes from the actual resumed interactive
session, not a synthetic test or manually inserted limit. Post-install data checks
preserved all 964 Stoneforge and 1070 photo-cleanup element IDs and payloads except
the two director entities' expected session metadata updates; both databases remain
healthy. The final interval observation is recorded below.

Final live observation: 148.9s with the watchdog enabled and daemon running,
zero watchdog prompts, unchanged exact 16:30 reset, both original director
conversations still running. Evidence: `LIVE_ACCEPTANCE.json` and the two
`stoneforge-terminal-live-*.json` snapshots in the backup directory.
