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

## Metrics clients: availability and subtotals — el-33hc

The follow-up updates the existing direct-DB `sf metrics` and Smithy metrics
page, without changing the collector, prices, schema, or historical records.
CLI supports its existing provider/model groupings and provider/date filters.
The dashboard consumes provider/model aggregates plus time-series buckets;
agent/session API responses share the additive frontend coverage types but
have no separate usage/cost consumer on this page. Quarry dashboard metrics
are task statistics; smithy-next metrics remain mock data and are outside this fix.

- CLI adds `usageStatus`, `usageSessionCount`, `legacySessionCount`,
  `estimatedCostStatus`, and `pricedSessionCount` to groups and totals. Existing
  numeric keys and token sums remain numeric and unchanged. Its model-cost query
  now uses the same observed-record/matched-price rules as the API, including the
  provider filter and one shared cutoff. It no longer applies the pricing helper's
  fallback to unknown models or estimates costs from unverified legacy usage.
- Measured zero renders as `0` / `$0.00`. Missing usage renders `unavailable`;
  legacy usage renders `unknown`. Incomplete tokens show `partial; recorded
  subtotal`, with an explicit warning when sums retain unverified legacy values.
  These recorded subtotals are not claimed to be verified/complete usage.
- Costs show `unavailable` when no records can be priced; partial costs are
  explicitly a `priced subtotal` of observed usage with matched prices. A
  measured zero can be priced zero; absent pricing cannot imply free usage.
- Dashboard cards, cache ratios, model rows and totals use coverage. Missing
  additive fields from older servers remain `unknown`; unverified old-server
  costs are excluded from a combined priced subtotal. Model table totals use
  model records from the same response, avoiding mixed refresh snapshots.
- Time-series buckets combine coverage before rendering. Unavailable/unknown
  buckets are null gaps, including nonzero unverified legacy buckets. Observed
  zero remains a plotted zero; partial points have recorded-subtotal tooltips.
  No incomplete total is presented as a complete chart total. The shared chart
  accepts null points and optional tooltip labels; default task tooltips persist.
- Counts are labelled **metric records**, not complete coverage of real sessions.
  Loading/errors/empty responses do not render zero token or cost measurements.

Focused acceptance on source `6392b438c2e5418e50235df55e25c27841e89a64`:

- Frozen pnpm install: exit 0 (pnpm 8.15.5). Quarry and smithy-web typecheck pass.
- `bun test packages/quarry/src/cli/commands/metrics-output.bun.test.ts`: 9/9 pass.
  Builds and executes the real Node CLI with a temporary SQLite database, checks
  text/JSON, both groupings, provider/date filters, measured zero, missing and
  legacy usage, partial/priced subtotals, unknown pricing and empty results.
- Existing metrics command tests: 14/14 pass. Their priced fixture now explicitly
  marks usage observed; separate legacy fixtures assert old counters are retained.
- `pnpm --filter @stoneforge/smithy-web exec vitest run src/routes/metrics/coverage.test.ts`:
  3/3 pass, covering mixed old/new responses, missing cost and per-bucket gaps.
- `PLAYWRIGHT_BROWSERS_PATH=/tmp/el-33hc-browsers pnpm --filter @stoneforge/smithy-web exec playwright test --config playwright.metrics.config.ts`:
  9/9 pass. Actual MetricsPage, query hooks, cards/table and charts render against
  intercepted API fixture responses; no backend starts. Covers states above,
  empty/error responses, tooltip, responsive widths 320/768/1024/1440, keyboard
  range selector and no page errors. Partial screenshot is in ignored
  `apps/smithy-web/test-results/metrics-coverage-visible-cards-table-and-chart-partial/provider-analytics.png`.
  Chromium is isolated under `/tmp`. Initial attempts failed on a missing browser
  and an overly broad fixture route matching source modules; both prerequisites
  were corrected, with no production workaround or weakened assertions.

Logs: `/tmp/el-33hc-{install,cli-output,cli-tests,ui-types,cli-types,unit,browser}.log`.
The full required merge gate and independent final review are recorded separately
below. This does not validate live providers, installed Desktop, billing, complete
collector coverage, packaged GUI, or the full browser suite. Installed app and
real projects/sessions were not changed. Source merge requires independent
steward review and the approved standalone CLI `task merge el-33hc --local`.

### Required gate and worker handoff — el-33hc

On source `6392b438c2e5418e50235df55e25c27841e89a64`, one full
`pnpm check:merge` returned **exit 1: 179/180 steps passed**, 155.10 s.
Uncached typecheck and Desktop source build passed; Bun 8,533 pass / 1 fail /
29 existing skips; Smithy Vitest 325 pass, Desktop Node 6 pass, gate tests 5 pass.
The sole failure is `packages/quarry/src/cli/commands/playbook.bun.test.ts:618`,
`allows valid inheritance chain during creation`: expected exit code 0, got 1.
That test and its playbook implementation are unchanged from local master
`e7c00526cc23e312e4def0bea8e259b77359e80f`. This does not establish the cause or
prove a baseline reproduction. The metrics-specific gate steps passed.

One isolated original-file rerun under the gate's `checkEnvironment()` passed
35/35. A fixed diagnostic series of five runs of a temporary copy, with extra
CommandResult logging, also passed 35/35 each. An initial diagnostic invocation
failed to resolve workspace imports from `/tmp`; absolute source imports fixed
only that fixture. These results do not erase the original failure or justify
calling the full gate successful. No full-gate retry-until-green, assertion change,
unrelated production fix or merge bypass was performed.

Tracked investigation **el-16z5** belongs to the same plan el-122b. A separate
screenshot observation, **el-2ohr**, tracks the existing shared-chart responsive
title spans appearing simultaneously in the isolated fixture; full-app reproduction
and root cause remain unconfirmed. Their markup was not changed by this task.

Gate logs `/tmp/el-33hc-gate.log`; commands/exits/durations and individual logs:
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-Cvgd8R/results.json`
(failure: `076.log`). Diagnostics:
`/tmp/el-33hc-playbook-original.log` and
`/tmp/el-33hc-playbook-diagnostic-{0..4}.log`.

Implementation and test source is committed/pushed; this final document-only
update preserves all previous provider-metrics findings and limitations. Worker
hands off rather than claiming acceptance. **Still required:** resolve/triage the
tracked gate failure, rerun the full required gate on the final revision, obtain
independent final-commit steward review, then use approved CLI local delivery.
No PR was created manually; no task merge, installed-app change, live migration,
backfill, paid provider request or session restart occurred.


### Integrated worker acceptance after el-16z5 — el-33hc, 2026-09-26

The blocker el-16z5 was independently reviewed and delivered as local master
`dca7189e8e28111c0fb643a33650222f69b3eb99`. All 299 approved el-ptim CLI
artifact hashes matched. Its `task sync el-33hc` merged that target without
conflicts into tested commit `d7cc1494c5e7dcaa7f849fcbeb7f648c9ba70da1`.
No metrics implementation or tests changed during this resumed acceptance.
The historical failed gate above is preserved: the collision defect is proven,
but attribution of that original failure remains unresolved (see el-43jm).

- `pnpm install --frozen-lockfile`: exit 0, lockfile unchanged.
- One integrated `pnpm check:merge`: **exit 0, 180/180 checks, 177.09 s**.
  Uncached typecheck 17/17; Bun 8,535 pass / 0 fail / 29 existing skips;
  Smithy Vitest 325 pass; Desktop Node 6 pass; gate regressions 5 pass;
  Desktop source build passed. This includes the real Node CLI metrics output
  suite (9), existing metrics command suite (14), and playbook suite (36).
- The isolated Playwright command above: **9/9 pass**, retries=0, 9.8 s.
  The partial-state screenshot was inspected: labels and subtotals are visible.
  The known duplicated responsive chart title remains separately tracked by
  el-2ohr; its unmerged source fix is not included in this acceptance.
- The coverage Vitest command above: **3/3 pass**.
- `git diff --check` and local-target ancestry: exit 0; target remained dca7189.

Logs: `/tmp/el-33hc-resume-{install,gate,browser,unit}.log`. Exact gate
commands, exits, durations and per-step logs:
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-c8mGBn/results.json`.
Node 22.23.3, pnpm 8.15.5, Bun 1.3.11, macOS arm64. Subsequent changes only
record these results in documentation. Shared el-1fqa and Directory updates
preserve other contributors' entries, including el-2ohr.

This is worker acceptance for transition to REVIEW, not independent approval.
Steward must review the final commit and use the approved CLI for local delivery;
if the target changes, sync and verify the resulting revision. No manual PR,
merge bypass, installed-app update, live project migration, provider calls,
backfill or session restart. Full browser suites, packaged GUI/LaunchServices,
standalone root build/lint/test and cross-platform checks were not run.
## Shared chart responsive titles — el-2ohr, 2026-09-26

Approved CLI sync brought the assigned worktree to local master
`e7c00526cc23e312e4def0bea8e259b77359e80f`. The duplicate title observed in
el-33hc is independently reproduced on that master in both an isolated
MetricsPage fixture and the real `/metrics` app entrypoint. All HTTP APIs and
WebSockets are intercepted; no backend, installed app or real project/session
is used. At 1280px both title spans display inline. This is a confirmed source
styling defect, independent of el-33hc's coverage/metric changes.

Cause: Smithy Web's Tailwind/PostCSS automatic source scan starts at the app
root. `packages/ui/src` is outside that scan. The desktop `sm:inline` utility
happens to be generated because FileContentSearch uses it in app source;
`sm:hidden` has no app usage and is absent from the generated stylesheet.
The shared TrendLineChart markup already requests both utilities correctly.
The three-line production diff explicitly registers `../../../packages/ui/src`
as a Tailwind `@source` in `apps/smithy-web/src/index.css`. No component, metric
calculation, caption, API or dependency is changed. Other existing shared UI
utilities (including responsive padding/type sizes) now compile consistently too.

The regression spec avoids utility-class literals that could themselves supply
missing candidates. It checks mutually exclusive spans and actual visible
heading text at widths 320, 639, 640, 768, 1280 and 1440, with real app CSS,
visible metric cards/table and no page errors. Both fixture and full app failed
at the original desktop visibility assertion. The first full-app harness also
failed because its mocked `/api/elements/all` lacked `data`; that fixture-only
error is preserved in the logs and corrected before the full-app reproduction.
The initial test's unused mobile expected-text typo was corrected before mobile
verification. Removing only the new source directive after the fix made both
final tests fail again at 1280px; restoring it passes both. This negative control
and the before/after CSS establish causality, rather than an unexplained pass.

Commands (Node 22.23.3, pnpm 8.15.5, Bun 1.3.11, macOS arm64):

```sh
pnpm install --frozen-lockfile
PLAYWRIGHT_BROWSERS_PATH=/tmp/el-33hc-browsers pnpm --filter @stoneforge/smithy-web exec playwright test --config playwright.responsive-title.config.ts
pnpm --filter @stoneforge/smithy-web build:web
pnpm check:merge
```

Frozen install passed. Final browser regressions: 2/2 pass, retries=0, 4.6s.
Frontend production build passed (10.07s); generated production CSS contains
both responsive display rules. Baseline and fixed PostCSS output are retained.
The existing el-33hc browser suite was additionally run with its ten frontend/UI
files from commit `c9a48d3` temporarily overlaid **only in this assigned worktree**:
9/9 pass (6.6s), covering measured zero, unavailable, legacy unknown, partial,
unpriced, old-server, mixed-bucket gaps and empty/error states. Partial labels
remain visible in cards/table/chart caption; the screenshot shows a single full
chart title. The overlay was restored byte-for-byte/removed afterward and is
not included in this task diff. This is compatibility evidence, not integration
or acceptance of the pending el-33hc task.

Required `pnpm check:merge`: **exit 0, 179/179 steps, 159.05s**, one full run.
Exact commands/exits/durations and step logs are retained at
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-StD1t3/results.json`.
This gate includes uncached workspace typecheck, the Desktop source build,
isolated Bun files, Smithy Vitest and Desktop Node integration; it does not
include the separately executed browser tests. Tested implementation/test tree
is committed as `e2af265`; subsequent documentation records this result.
`git diff --check` passed; local master remains e7c0052.

Evidence is retained in `/tmp/el-2ohr-evidence/`: `baseline-browser.log`,
`full-app-harness.log`, `full-app-baseline.log`, `negative-control.log`,
`fixed-browser.log`, `final-browser.log`, `pending-metrics-integration.log`,
`install.log`, `build-web.log`, `gate.log`, `baseline.css`, `fixed.css`, and
corresponding `*-results/` screenshots/error contexts. Original el-33hc screenshot
and its unrelated historical playbook gate failure remain preserved. No retry
until green or weakened assertions/gate. Browser coverage is Chromium only;
installed/packaged app, live providers and other browsers were not tested.

Independent steward review of the final commit and approved CLI local delivery
are still required; this worker report does not claim independent approval or
an installed-app update.

## Cache hit rate denominator and legacy policy — el-10qu, 2026-09-26

The dashboard now uses one calculation for the provider summary card, each
model row, and the model total:

`100 * sum(cacheRead) / sum(uncachedInput + cacheRead + cacheCreation)`

Rounding happens once after summing tokens, not by averaging model percentages.
No clamp is used. For example, normalized input=20/read=80 gives 80%; input=0/
read=100 gives 100%; input=100/read=0 gives 0%; input=20/read=60/create=20
gives 60%. Cache creation/write is input but is not a cache hit. Output and
reasoning tokens do not belong in the denominator. The measured empty
input denominator is undefined, rendered **N/A (no input tokens)**, never 0%.

Source semantics checked in `providers/codex/event-mapper.ts` and
`services/session-metrics.ts`: Codex provider `inputTokens` includes cached
input. The mapper subtracts `cachedInputTokens` and optional
`cacheWriteInputTokens`, storing three disjoint input categories. Claude raw
`input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`
are tracked separately. Result/modelUsage cache counters reconcile with maxima,
not another addition; duplicate decomposed Claude messages are deduplicated.
The regression exercises repeated Codex write/read updates through mapper,
tracker, real temporary SQLite and API, retaining 20/60/20 and the existing
`totalTokens=30` with output=10. Existing Claude spawner/API tests exercise
100 uncached + 30 read + 10 creation. This fix does not alter collection,
pricing, public numeric token totals, storage, or historical records.

The existing coverage contract governs ratio availability, with a stricter
legacy rule because retained token sums have no observed-only breakdown:

- All observed records: numeric rate, or N/A for the measured empty denominator.
- Partial usage with explicitly zero legacy records: recorded ratio labelled
  `partial; recorded ratio`; it does not estimate the missing usage. An empty
  denominator similarly remains N/A with the partial label.
- Any legacy records, missing old-server coverage fields, or invalid numeric
  categories: **unknown**, including aggregates that also contain measured rows.
  No percentage is calculated from ambiguous historical values or selectively
  chosen known groups. This preserves consistent aggregate behavior regardless
  of provider/model grouping boundaries. Individual measured rows remain usable.
- No observed usage and no legacy, including an empty response: **unavailable**.

Other numeric subtotals intentionally retain the existing unverified legacy
values and their existing labels. Usage coverage and ratio availability can
therefore differ: a partial token subtotal containing legacy has an unknown
cache ratio. Existing documents' earlier denominator-defect note describes the
historical el-33hc state; el-10qu corrects it in source only.

Implementation/test commit: `7c8a760`. Frozen pnpm install passed, lockfiles
unchanged (pnpm 8.15.5, Node 22.23.3, Bun 1.3.11, macOS arm64).

- Before the fix, the new unit suite failed 8/13 cases, including 400% instead
  of 80%, all-cache 0% instead of 100%, creation and mixed weighted aggregates.
- `pnpm --filter @stoneforge/smithy-web exec vitest run src/routes/metrics/coverage.test.ts`:
  13/13 pass after the fix.
- `bun test packages/smithy/src/services/session-metrics.bun.test.ts`:
  7/7 pass, 55 assertions (includes the new cache-write ingestion regression).
- `PLAYWRIGHT_BROWSERS_PATH=/tmp/el-33hc-browsers pnpm --filter @stoneforge/smithy-web exec playwright test --config playwright.metrics.config.ts --output /tmp/el-10qu/browser-results`:
  22/22 pass, retries=0, 13.4s. Actual MetricsPage with intercepted API only;
  no backend/live project. Checks card/model/total agreement for 80%, 100%, 0%,
  empty denominator, creation, weighted models, partial, legacy, old-server and
  unavailable; existing responsive widths 320/768/1024/1440, keyboard selector,
  chart gaps/tooltips, page errors and empty/error responses also pass. Weighted
  screenshot inspected: 80% and 0% rows, 8% card and total are visible.

Logs and browser artifacts: `/tmp/el-10qu/` (`unit-baseline.log`, `unit.log`,
`ingestion.log`, `browser.log`, `browser-results/`, `install.log`). Full required
gate and independent final-commit review are recorded separately below.
Installed Desktop, live projects and sessions were not modified. No provider
calls, backfill, migration of live data, packaged GUI or full browser suite.

### Final worker gate — el-10qu

One full explicit `pnpm check:merge` on implementation/test commit
`7c8a76033e7731241e09f24ac5ffaf2c2787ad80`: **exit 0, 180/180 steps,
271.21s**. Uncached typecheck 17/17 (0 cached); Bun 8,536 pass / 0 fail /
29 existing skips; Smithy Vitest 325 pass; Desktop Node integration 6 pass;
gate regressions 5 pass; Desktop source build pass. No gate changes, bypass,
or reruns. The separately run frontend unit/browser checks above are not
implicitly part of this gate.

Full log `/tmp/el-10qu/gate.log`, exit `/tmp/el-10qu/gate.exit`;
exact commands, exits, durations and per-step logs:
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-52FK0P/results.json`.
`git diff --check` and local target ancestry pass; source target remains
`dad94699d5cad27a7104d236c8df23e0c1eb14c2`. The following commit changes only
this report. Shared document el-1fqa and Directory el-1s1 were reread before
updates, preserving other entries; no new document or channel was created.

Worker source acceptance is complete. Independent steward review of the final
commit remains required before approved CLI `task merge el-10qu --local`.
Worker uses `sf task complete` to enter that review lifecycle, not manual PR
creation or self-merge. This report does not claim independent approval or an
installed-app update; installed app, projects and running sessions are unchanged.
