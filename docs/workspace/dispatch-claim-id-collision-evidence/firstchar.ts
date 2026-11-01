import { toBase36 } from '/Users/citius/Desktop/Work/Stoneforge/.stoneforge/.worktrees/core/e-worker-1-7a21f61d-efba-48e2-a171-fbe52adc454e-id-fixture-dispatch-claim-cre/packages/core/src/id/generator.ts';
const N = 200000; const counts = new Map<string, number>(); const buf = new Uint8Array(32);
for (let i = 0; i < N; i++) { crypto.getRandomValues(buf); const c = toBase36(buf)[0]; counts.set(c, (counts.get(c) ?? 0) + 1); }
let s = 0; for (const v of counts.values()) s += (v / N) ** 2;
const pair4 = s / 36 ** 3;
console.log(JSON.stringify({ N, firstChars: Object.fromEntries([...counts].sort()), sumP2: s, pairCollision4: pair4, uniform4: 1 / 36 ** 4, perBeforeEach5Seeds: 5 * pair4, per53Tests: 53 * 5 * pair4 }, null, 1));
