# Active-agent cache indicator — el-1onu

## Scope and source semantics

`ActiveAgentCard` calls `useAgentTokens(agentId, session.id)`, which uses the
session-specific provider-metrics query. The route calls `getBySession` and
retains usage coverage through cost enrichment. The hook previously discarded
that coverage. It now preserves the existing optional `UsageCoverage` fields;
other hook consumers keep their numeric values and formatting.

Confirmed in the Codex event mapper, session tracker and metrics service:
`inputTokens` is uncached input, cache read and creation are separate categories,
and `totalTokens` remains uncached input plus output. The unchanged collector
normalizes Codex input by subtracting read/write; Claude categories are already
separate. See workspace reference el-1fqa and the el-10qu denominator agreement.

The existing **High cache hit rate** badge now requires:

- Complete observed coverage (`available`, positive session count, every session
  measured and explicitly zero legacy sessions).
- Finite nonnegative input categories and a finite positive input denominator.
- `cacheRead / (uncachedInput + cacheRead + cacheCreation) > 0.1`.

The strict >10% threshold and badge/title styling are unchanged. Output tokens
are excluded. Creation counts as input, never a hit. Unknown, missing old-server,
unavailable, partial, or legacy coverage cannot produce an unqualified High badge.
Unlike the metrics page, this compact badge has no partial-ratio qualifier, so
partial coverage is deliberately suppressed rather than labelled complete.

The token row also renders for complete measured usage when `totalTokens=0`:
all-cache can show its badge, creation-only shows its existing tooltip, and
measured empty shows `0 in / 0 out` without a badge. Unavailable/unknown zero
remains absent. Existing nonzero token rows, uncached-input/output formatting,
cache read/creation tooltip details and cost tooltip formatting are retained.
No collector, pricing, history, public numeric totals or layout redesign.

## Validation

Implementation/test commit: `f81f699db095189160672e8c25bca9e8cbf207b2`.
Approved CLI sync used shared STONEFORGE_ROOT and local master `dad9469`;
no pending el-10qu branch was copied. All changes are in the assigned worktree.
Node 22.23.3, pnpm 8.15.5, Bun 1.3.11, macOS arm64.

- `pnpm install --frozen-lockfile`: exit 0; lockfiles unchanged.
- Before the fix, browser regressions failed 12/18 cases, including below/at
  threshold, all-cache, creation, measured empty and unsupported coverage.
- `PLAYWRIGHT_BROWSERS_PATH=/tmp/el-33hc-browsers pnpm --filter @stoneforge/smithy-web exec playwright test --config playwright.active-agent.config.ts --output /tmp/el-1onu/browser-results`:
  exit 0, 18/18 scenarios, both interactive and headless cards per scenario,
  retries=0, 7.7s on the implementation commit. Actual cards and query hooks
  consume intercepted HTTP; each request is asserted session-specific. Covers
  below/at/above threshold, all-cache with zero output, creation, measured empty,
  measured zero read, excluded output, legacy/old-server/partial/unavailable,
  compact display and full tooltips. No page errors. Query-settlement marker
  prevents absence assertions from passing before requests render. All-cache
  and measured-empty screenshots were visually inspected.
- `pnpm --filter @stoneforge/smithy-web exec vitest run src/api/hooks/useAgentTokens.test.ts`:
  exit 0, existing 5/5 formatting tests.

Logs and browser artifacts: `/tmp/el-1onu/` (install.log, browser-baseline.log,
browser-final.log, browser-results/, unit.log). The full explicit required gate
and final review lifecycle are recorded below after completion.

Installed Desktop, live projects and sessions are unchanged. No live provider
calls, packaged GUI, full browser suite or billing validation. Independent
final-commit steward review remains required before approved CLI local delivery;
worker completion enters review and does not constitute independent approval.

## Integrated source acceptance

The first explicit `pnpm check:merge` on `f81f699` passed: 180/180 steps,
278.17s, Bun 8,535 pass / 0 fail / 29 existing skips. During that run el-10qu
was independently approved and delivered to local master `d121628`.
Approved CLI sync then merged that target without conflicts, producing tested
source `fe8eb7b3784ad2154909fea0c4cb4a749be67db3`; no task implementation
changed. Target ancestry and `git diff --check` pass.

On the integrated source:
- Active-agent browser suite: 18/18 pass, retries=0, 13.4s. Output and log:
  `/tmp/el-1onu/browser-integrated/`, `/tmp/el-1onu/browser-integrated.log`.
- Existing metrics-page browser suite: 22/22 pass, retries=0, 18.6s, using
  `playwright.metrics.config.ts` and `/tmp/el-1onu/metrics-integrated` output.
  Log: `/tmp/el-1onu/metrics-integrated.log`.
- Token formatting plus metrics coverage unit suites: 18/18 pass (5 + 13).
  Log: `/tmp/el-1onu/unit-integrated.log`.

Initial gate: `/tmp/el-1onu/gate.log`; per-step commands/exits:
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-koGcHN/results.json`.

Final explicit `pnpm check:merge` on integrated source `fe8eb7b`: **exit 0,
180/180 steps, 332.99s**. Uncached typecheck 17/17 (0 cached), Bun 8,536
pass / 0 fail / 29 existing skips, Smithy Vitest 325 pass, Desktop Node 6 pass,
gate regressions 5 pass and Desktop source build pass. No gate filtering,
bypass or retry-until-green; the second full run validates the new local target.

Final gate log `/tmp/el-1onu/gate-final.log`, exit `gate-final.exit`;
exact commands/exits/durations and per-step logs:
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-dvNFAA/results.json`.
The final documentation commit does not change tested implementation or tests.
Shared reference el-1fqa and Directory el-1s1 were reread before appending this
result, preserving concurrent entries. No new shared document or channel.
Worker source acceptance is complete; independent steward review of the final
commit and approved CLI `task merge el-1onu --local` remain required.
