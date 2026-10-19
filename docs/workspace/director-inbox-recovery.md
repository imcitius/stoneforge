# Director replacement inbox recovery and macOS clipboard — 2026-10-03

## Confirmed inbox failure

Read-only inspection of the photo-cleanup database located report `el-f2s41`
(2026-10-02T21:46:58Z) in direct channel `el-5mf7`, named
`backend-worker:director`. Its recipients include the retired director `el-3pjo`,
soft-deleted on September 30. The inbox item remains unread for that identity.
Current director `el-2ckq` has the same name but a different identity. Another
channel, `el-uyot`, has the same display name and the current director as member;
its earlier reports reached that director's inbox. This is an identity replacement
failure, not missing inbox support for direct channels.

The dispatch daemon now also scans retired directors' inboxes, forwarding pending
messages to a unique live director with the same name. It requires a running
session and honors forwarding opt-out, disabled state, recent human input, manual
sleep and the recipient provider's quota. It leaves the original item unread on
failed delivery and uses the existing in-flight guard against concurrent duplicate
delivery. It does not revive agents, change memberships or rewrite history.
Renamed replacements, multiple same-name candidates and hard-deleted recipients
are deliberately not guessed. Existing PTY acceptance is not an acknowledgement
that the model has understood a message.

## Clipboard evidence and limits

The reported characters match UTF-8 bytes decoded as MacRoman. Finder may launch
Desktop with no locale, which is inherited by terminal agents and macOS `pbcopy`.
Desktop now supplies UTF-8 character encoding when the effective locale is absent
or non-UTF-8, including LC_ALL precedence; existing UTF-8 locale is preserved.
This applies to newly started managed backends/sessions, not an adopted old server.

`apps/desktop/scripts/check-clipboard.mjs` exercises Electron 44.4.5 and xterm 6:
actual mouse selection plus Cmd+C preserves Cyrillic, punctuation and emoji.
Native `pbcopy` with no locale or LC_ALL=C reproduces corruption; the Desktop
backend environment preserves the same Unicode exactly. Standard xterm copy uses
browser ClipboardEvent Unicode and does not invoke pbcopy. The original live
session's internal selection/copy path has not been reproduced; the locale repair
addresses the confirmed native helper failure, not a demonstrated xterm defect.

The native check temporarily uses the system clipboard and clones all clipboard
item types before restoring them. The first diagnostic run failed restoration
because Electron 44 rejects writing read-only ClipboardItems back directly;
constructing new items fixes the verification script. That first run left its
test string in the clipboard; the corrected run completed successfully.

## Verification

- Required `pnpm check:merge`, pinned Node 22.23.3: **192/192 passed**, 243.76s.
  Evidence: `/tmp/stoneforge-inbox-gate.log`; full logs in
  `/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-LxlLi7`.
- Final daemon regression suite: **160 passed, 2 existing skips, 0 failures**,
  including delivery to replacement, failed delivery/retry, unrelated-name
  exclusion, opt-out/typing/quota/disabled guards, missing session and concurrent
  polling. The concurrent case and independent disabled assertion were added
  after the gate began and checked with this final targeted run.
- Desktop locale test and Smithy typecheck passed.
- Native clipboard check passed after the verification-script correction above.

Source remains based on the previously installed director-liveness changes.
Git author identity is not configured; no commit identity was invented. Packaging
and installation are separate from these source checks. No live messages were
sent or live databases changed during investigation/testing.
