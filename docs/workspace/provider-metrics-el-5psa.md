# Provider metrics attribution and availability — el-5psa

## Evidence and cause (2026-09-26)

Installed Desktop build-info identifies `0.1.0`, commit
`497e0995c285020c17a23bbe0513e4126ca5f92c`, built at 12:07:38Z. The app
was not replaced, restarted or used to run paid test sessions. Source was synced
through the approved `/tmp/stoneforge-el-ptim-151b314/sf task sync el-5psa`
with shared `STONEFORGE_ROOT`; initial source base was local master `bb7a938`.

The earlier installed response in `/tmp/el-1r6-steward/metrics-provider.json`
contains 55 rows counted as sessions, all `claude-code`, model grouping `unknown`,
zero token counters and estimated cost. Four current agent settings alone do
not establish any historical session's provider.

A concrete read-only correlation establishes the defect:

- `sf show el-38k9 --json` session history maps
  `session-muigm8p9-001f-j81s` to provider thread
  `01a0de06-cd95-79e2-81c9-255ffa741278`, 14:03:03Z–14:12:03Z.
- Authenticated GET through the CLI's `orchestratorFetch` confirmed that session's
  metric has zero tokens. Its persisted messages contain 49 `commandExecution`
  and one `fileChange` tool calls, but do not retain raw usage notifications.
- The matching local Codex rollout records `originator=stoneforge`, CLI `0.157.0`,
  `model_provider=openai` and turn model `gpt-6-astra`. Its 32 token-count events
  culminate in 2,690,376 input tokens (including 2,584,192 cached), 14,423 output
  tokens (including reasoning). These are provider-reported thread counters,
  not billing evidence. They were inspected, not imported or used for backfill.

Sanitized correlation is `/tmp/el-5psa/session-evidence.json`. Raw read snapshots
remain local in `/tmp/el-5psa/{worker,sessions,specific-metric,messages}.json`.
No prompts, credentials or transcript contents are included in this report.

Both installed `backend/dist/server/services.js` and current source
`packages/smithy/src/server/services.ts` hardcode `provider = 'claude-code'`.
The collector initializes every usage counter to zero and only understands
Claude SDK usage. Codex's mapper drops `thread/tokenUsage/updated`, so actual
usage never reaches the collector. Session records/history previously omitted
provider/model, and spawner conversion overwrote Claude's raw `message` object
with display text, losing assistant usage/model even for Claude.

This is a source defect, not merely an already-fixed source awaiting installation.

## Source behavior after this change

- Spawner captures the actual selected provider and requested model for each
  spawn. Provider init can supply a resolved model; this is retained in public
  session records and subsequent history, independently of later agent edits.
  Legacy history stays without provider/model, never inferred from current agents.
- The existing daemon session collector uses that snapshot (missing provider is
  `unknown`), preserves and consumes Claude raw messages, deduplicates SDK message
  IDs across decomposed text/tool blocks, and reconciles cumulative result usage.
  Sessions observed using multiple Claude models retain usage but have unknown
  model for pricing rather than pricing all usage as the first model.
- Codex maps documented `thread/tokenUsage/updated` totals to a system usage event.
  Fixtures use the schema generated offline by local `codex-cli 0.157.0` with
  `codex app-server generate-json-schema --out /tmp/el-5psa/codex-schema`.
  Foreign-thread, malformed and inconsistent counters are ignored. Duplicate
  cumulative updates are not added twice. Cached and cache-write input are
  separated from uncached input; reasoning is already part of output.
- Schema 13 adds nullable `usage_available`. Existing rows remain byte-for-byte
  equivalent in their original columns; the new value is NULL (unverified).
  New missing usage is 0, explicitly observed usage (including actual zero) is 1.
  No historical attribution or usage is rewritten. Migration is tested only on
  fixtures; the running project has not been migrated with this source.

## Compatible API additions

Existing numeric keys and response shape remain. Each aggregate and time-series
point adds `usageStatus`, `usageSessionCount`, and `legacySessionCount`:

| Status | Meaning |
| --- | --- |
| available | Every included row has observed usage, including measured zero |
| partial | Some included rows have observed usage |
| unavailable | No observed usage and no unverified legacy rows |
| unknown | No observed usage; at least one row predates availability tracking |

Numeric token sums retain their existing semantics and legacy values; they are
not evidence of complete usage when coverage is incomplete. `totalTokens` remains
input plus output, with cache categories separate, as in the existing API.
`available` means usage was observed, not that every provider event was delivered.

Cost enrichment consistently queries observed per-model usage for provider,
model, agent and session groupings. It uses existing matched prices only, with
no Sonnet fallback for unknown model/pricing or query errors. `estimatedCost`
remains a numeric **subtotal**, with `estimatedCostStatus` (available, partial,
unavailable) and `pricedSessionCount`. Zero with `unavailable` means no estimate,
not free usage. Known-model measured zero yields available zero. No new prices
are introduced. The separate standalone pricing helper retains its legacy API;
these restrictions apply to provider-metrics enrichment.

Clients must read coverage alongside numeric fields; older clients that ignore
new fields can still render an incomplete zero. The existing direct-DB `sf metrics`
CLI and dashboard formatting are not redesigned here. API fields are additive.

## Limits and follow-up boundaries

- Codex resumed threads report lifetime totals; the available resume response
  has no usage baseline. This change deliberately suppresses resumed-thread
  usage rather than charging previous runs to the new spawn. Such sessions stay
  unavailable unless another attributable usage path is implemented separately.
- Metrics listeners still belong to the existing daemon callback. Interactive
  sessions and paths without that listener are not made complete by this fix.
  Events emitted before listener attachment can still be missed. Session counts
  describe recorded metric rows, not all registered agents or all real sessions.
- There is no new OpenCode collector. Its attribution is captured correctly,
  but absent supported usage remains explicitly unavailable.
- Model snapshots are selected/resolved configuration, not proof of billed model
  routing. Unknown/multi-model pricing, unsupported provider usage and historical
  backfill need separately scoped decisions. Real prices/costs are not inferred.
- Source merge will not change installed Desktop `497e099`. A separately reviewed
  app update including this task's final source commit is required to activate it.
  No live project/session changes, historical backfill or app replacement occurred.

## Validation and delivery

Focused real-SQLite/Hono API tests cover all groupings, time-series coverage,
missing versus measured zero, legacy migration preservation, observed/priced
subtotals and date filtering, Codex cumulative events, and Claude tool/text usage
through the real spawner. Mocked Codex client tests exercise the actual headless
provider → spawner → tracker, resolved model and resume exclusion. Session manager
regression verifies historical provider/model survive an agent-settings change
and a fresh manager. No provider request is made by these tests.

Focused suites passed: metrics service 33, session manager 85, spawner 72,
Codex event mapper 44, headless 11, compatibility 13, new ingestion/API 6.
Smithy typecheck passed. One direct compatibility rerun without fixture environment
isolation failed two existing environment assertions because the worker's
STONEFORGE_DESKTOP_INSTANCE_ID was inherited; the same final suite passed under
`checkEnvironment()` from the gate (13/13). No assertion was weakened.
Full current `pnpm check:merge`, final source hash and independent steward review
are recorded below when available. Local delivery belongs to the independent
steward using only the approved CLI `task merge el-5psa --local`, after final review.

### Final worker acceptance

Implementation commit `a9f18a0`; after approved CLI sync with local master
`37a4969d19e9bd8239c5739e9c911b14557073b0`, tested source commit
`a8ba22cc51c8422be0b476b91e3a3c03ff1f7be6`. Clean assigned worktree,
`git merge-base --is-ancestor master HEAD` exit 0. Node 22.23.3,
pnpm 8.15.5, Bun 1.3.11, macOS arm64. Frozen install completed successfully.

One full `pnpm check:merge` on that source: **exit 0, 178/178 steps, 138.77 s**.
Uncached typecheck 17/17, gate regressions 5, Bun 8,507 pass / 0 fail /
29 existing skips, Smithy Vitest 325 pass, Desktop Node integration 6 pass.
Fresh Desktop source build passed. This does not claim packaged GUI validation,
installation, live provider calls, full browser suites, or standalone root lint/test.

Full worker logs: `/tmp/el-5psa/{install-final,gate}.log`, gate exit and summary
in `gate.exit` / `gate-summary.json`. Exact commands, exits, durations and step
logs: `/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-97kkIT/results.json`.
Subsequent commit changes only this validation report; production/test source
remains the tested revision. Task branch is pushed; independent final-commit
steward review and approved CLI local delivery are still required.

Workspace reference: `el-1fqa`, added via `sf docs add`; existing runbook `el-of6`
and audit `el-3d6` link the diagnosis. Directory `el-1s1` was reread immediately
before updates and other agents' entries were preserved.
