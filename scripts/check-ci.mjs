// CI entry point for the pre-merge gate (pnpm check:ci), used by
// .github/workflows/ci.yml on ubuntu. It runs the gate itself: the same runtime
// and native preflight, the same mergeChecks() step list and the same per-file
// Bun isolation as pnpm check:merge. The only difference is that it also runs
// on Linux; check:merge refuses non-macOS hosts because macOS acceptance must
// include tests that skip themselves elsewhere (see docs/merge-checks.md,
// "CI vs gate"). No step is filtered here.
import { runMergeGate } from './check-merge.mjs';

if (process.argv.length !== 2) throw new Error('Usage: pnpm check:ci (no filtering or skip flags)');
if (!['darwin', 'linux'].includes(process.platform)) throw new Error(`check:ci supports macOS and Linux, not ${process.platform}.`);
process.exitCode = runMergeGate();
