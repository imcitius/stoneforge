# Director human-input notifications — 2026-10-03

## Behavior

The session manager adds an explicit human-input instruction to every new/resumed
director session, including workspace prompt overrides. Before its final question,
a director runs `sf agent await-input`. The bundled CLI authenticates against its
own workspace backend using the existing discovery protocol; session and agent
IDs must match a current running director. An unavailable server is an error,
not a successful local database fallback.

Supported structured question events also signal attention. Terminal text,
redraws and inactivity do not: replaying an old question must not block dispatch.
A signal remains until successful human input, a subsequent tool action, quota
failure or session termination. While waiting, the daemon neither nudges the
director nor pastes worker reports into its question; unread reports remain
pending. Delayed delivery updates the latest session state so it cannot erase a
new question or resurrect an answered one.

Desktop polls all ready projects from its main process every three seconds.
A pending request older than five seconds creates one native notification with
the project name and a sidebar badge. Clicking restores the window and selects
that project. A second request remains pending during the one-minute per-session
notification cooldown. Stopped/replaced instances and results arriving after
monitor shutdown are ignored. Closing the window keeps this monitoring active.

## macOS delivery

Packaging signs the complete bundle ad hoc and verifies the signature. This
gives Electron's native notification API the final application identity, without
a Developer ID, notarization, credential changes or modified OS settings.
Notification Center delivery was verified on this Mac with an isolated probe;
banner visibility and sound still follow the user's macOS notification/Focus
settings.

## Verification scope and limitations

The source tests cover explicit signaling, stale/mismatched IDs, worker exclusion,
HTTP input reset, terminal redraw replay, delayed delivery/state races, watchdog
and inbox suppression, all-project monitoring, cooldown, instance replacement
and monitor shutdown.

`apps/desktop/scripts/check-attention.mjs` uses the exact signed app, isolated
projects/userData and a deterministic fake provider. It runs the real bundled
CLI from a real PTY session, checks native Notification Center history while the
other project is selected and the window hidden, invokes the notification click
callback, then answers through the real WebSocket/PTY path and checks badge
clearance. The callback is simulated; physical clicking of a macOS banner is
not automated. No provider API calls or live workspace mutations are involved.

Detection requires the explicit signal or a supported structured question event.
An arbitrary question or CLI permission prompt in terminal text is not inferred.
Existing sessions need a restart/resume to receive the new instruction. Desktop
must be running; no separate OS background service is installed. Native
notification permission remains under the user's control.
