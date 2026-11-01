/**
 * el-45m5h: exact + empirical evaluation of the leading-digit bias in
 * core generateId (toBase36(SHA-256) truncated to the first L characters).
 *
 * Run from the repository root:
 *   bun docs/workspace/id-base36-bias-el-45m5h/analyze.ts [samples]
 *
 * Model: SHA-256 output is uniform on [0, 2^256). toBase36 emits no leading
 * zeros, so a digest D with n base36 digits yields prefix P = floor(D / 36^(n-L))
 * (an L-digit number with non-zero leading digit). Counting all D that map to a
 * given P across every digit-length n gives the exact prefix distribution:
 *   count(P) = A + B(P), A = sum_{n=L}^{49} 36^(n-L)  (n <= 49 always fully fits),
 *   B(P) = 36^(50-L) if P < T, (2^256 - T*36^(50-L)) if P == T, else 0,
 *   T = floor(2^256 / 36^(50-L)).
 * Digests with fewer than L digits (probability < 36^L / 2^256) are ignored;
 * they would yield shorter IDs and are negligible (< 1e-68 for L = 8).
 */
import { toBase36, truncateHash } from '../../../packages/core/src/id/generator.ts';

const TWO256 = 1n << 256n;
const B36 = 36n;
const pow36 = (k: number) => B36 ** BigInt(k);
const SCALE = 10n ** 40n;
const toFloat = (num: bigint, den: bigint) => Number((num * SCALE) / den) / 1e40;

// Sanity: 36^49 < 2^256 < 36^50
if (!(pow36(49) < TWO256 && TWO256 < pow36(50))) throw new Error('digit-length assumption broken');

interface Row {
  L: number;
  sumP2: number; // exact collision probability of two independent IDs
  uniformP2: number; // 1 / 36^L (ideal: L uniform base36 chars)
  ratio: number;
  h2Bits: number; // Renyi-2 (collision) entropy
  nominalBits: number; // L * log2(36)
  lostBits: number;
  usedPrefixes: string; // fraction of the 36^L prefix space with p > 0
}

function exactRow(L: number): Row {
  let A = 0n;
  for (let n = L; n <= 49; n++) A += pow36(n - L);
  const full50 = pow36(50 - L);
  const T = TWO256 / full50;
  const partial = TWO256 - T * full50;
  const lo = pow36(L - 1); // smallest L-digit prefix
  const hi = pow36(L); // exclusive
  // prefixes in [lo, T): A + full50 ; P == T: A + partial ; (T, hi): A
  const nBig = T - lo;
  const nSmall = hi - T - 1n;
  const cBig = A + full50;
  const cT = A + partial;
  const total = nBig * cBig + cT + nSmall * A;
  // total must equal number of digests with >= L digits
  if (total !== TWO256 - pow36(L - 1)) throw new Error(`count mismatch L=${L}`);
  const sumSq = nBig * cBig * cBig + cT * cT + nSmall * A * A;
  const sumP2 = toFloat(sumSq, total * total);
  const uniformP2 = 1 / Number(pow36(L));
  const h2Bits = -Math.log2(sumP2);
  const nominalBits = L * Math.log2(36);
  return {
    L,
    sumP2,
    uniformP2,
    ratio: sumP2 / uniformP2,
    h2Bits,
    nominalBits,
    lostBits: nominalBits - h2Bits,
    usedPrefixes: `${((Number(hi - lo) / Number(hi)) * 100).toFixed(2)}%`,
  };
}

function exactFirstChar(): Map<string, number> {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  const rows = exactRowCounts(1);
  const out = new Map<string, number>();
  for (let d = 0; d < 36; d++) out.set(chars[d], rows(BigInt(d)));
  return out;
}

function exactRowCounts(L: number): (P: bigint) => number {
  let A = 0n;
  for (let n = L; n <= 49; n++) A += pow36(n - L);
  const full50 = pow36(50 - L);
  const T = TWO256 / full50;
  const partial = TWO256 - T * full50;
  const total = TWO256 - pow36(L - 1);
  return (P: bigint) => {
    if (P < pow36(L - 1)) return 0;
    const c = A + (P < T ? full50 : P === T ? partial : 0n);
    return toFloat(c, total);
  };
}

// ---- exact output ----------------------------------------------------------
console.log('# Exact leading-character distribution (L = 1)');
const fc = exactFirstChar();
const fcLine = [...fc.entries()].map(([c, p]) => `${c}=${(p * 100).toFixed(3)}%`).join(' ');
console.log(fcLine);
console.log(`sum p^2 (first char) = ${[...fc.values()].reduce((s, p) => s + p * p, 0).toFixed(6)} (uniform 36: ${(1 / 36).toFixed(6)})`);

console.log('\n# Second character marginal (exact, L = 2 summed over first char)');
{
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  const f = exactRowCounts(2);
  const m = new Array(36).fill(0);
  for (let a = 1; a < 36; a++) for (let b = 0; b < 36; b++) m[b] += f(BigInt(a * 36 + b));
  console.log(m.map((p, i) => `${chars[i]}=${(p * 100).toFixed(3)}%`).join(' '));
  console.log(`sum p^2 (second char) = ${m.reduce((s, p) => s + p * p, 0).toFixed(6)}`);
}

console.log('\n# Exact prefix collision statistics, hash length L');
console.log('L | sum p^2 (exact) | uniform 36^-L | ratio | H2 bits | nominal bits | lost bits | reachable prefixes');
const rows: Row[] = [];
for (let L = 1; L <= 8; L++) {
  const r = exactRow(L);
  rows.push(r);
  console.log(
    `${r.L} | ${r.sumP2.toExponential(4)} | ${r.uniformP2.toExponential(4)} | ${r.ratio.toFixed(4)} | ${r.h2Bits.toFixed(3)} | ${r.nominalBits.toFixed(3)} | ${r.lostBits.toFixed(3)} | ${r.usedPrefixes}`,
  );
}

// Birthday / per-insert impact at the adaptive thresholds used by calculateIdLength
console.log('\n# Impact at calculateIdLength thresholds (N = upper bound of each band)');
console.log('L | N | P(new ID hits one of N existing) actual / uniform | P(any pair among N collides) actual / uniform');
const bands: [number, number][] = [[3, 100], [4, 500], [5, 3000], [6, 20000], [7, 100000], [8, 1000000]];
for (const [L, N] of bands) {
  const r = rows[L - 1];
  const hit = (p2: number) => 1 - Math.exp(-N * p2);
  const pair = (p2: number) => 1 - Math.exp(-(N * (N - 1)) / 2 * p2);
  console.log(
    `${L} | ${N} | ${(hit(r.sumP2) * 100).toFixed(3)}% / ${(hit(r.uniformP2) * 100).toFixed(3)}% | ${(pair(r.sumP2) * 100).toFixed(2)}% / ${(pair(r.uniformP2) * 100).toFixed(2)}%`,
  );
}

// Unchecked callers default to L = 4 regardless of database size
console.log('\n# Unchecked default (L = 4, no checkCollision): P(new ID equals an existing one)');
for (const N of [500, 1323, 3000, 10000]) {
  const r = rows[3];
  console.log(
    `N=${N}: actual ${((1 - Math.exp(-N * r.sumP2)) * 100).toFixed(3)}% vs uniform ${((1 - Math.exp(-N * r.uniformP2)) * 100).toFixed(3)}%`,
  );
}

// ---- candidate remediation: low-order digits (D mod 36^L, zero-padded) ------
// 2^256 = q*36^L + r: r residues occur q+1 times, the rest q times.
console.log('\n# Candidate: low-order L digits (D mod 36^L, left-padded with 0) - exact');
console.log('L | sum p^2 / uniform - 1 | H2 lost bits');
for (let L = 3; L <= 8; L++) {
  const M = pow36(L);
  const q = TWO256 / M;
  const r = TWO256 % M;
  const sumSq = r * (q + 1n) * (q + 1n) + (M - r) * q * q;
  // excess = M*sumSq / 2^512 - 1 = r*(M - r) / 2^512 (verified exactly below)
  const excessNum = M * sumSq - TWO256 * TWO256;
  if (excessNum !== r * (M - r)) throw new Error(`candidate identity failed L=${L}`);
  const excess = Number(excessNum) / 2 ** 512; // both within double range
  console.log(`${L} | ${excess.toExponential(3)} | ${(Math.log2(1 + excess)).toExponential(3)}`);
}

// ---- empirical cross-check using the production toBase36/truncateHash -------
const samples = Number(process.argv[2] ?? 200000);
console.log(`\n# Empirical cross-check: ${samples} random 32-byte digests through production toBase36 + truncateHash`);
const counts = new Map<number, Map<string, number>>();
for (const L of [1, 3, 4]) counts.set(L, new Map());
const buf = new Uint8Array(32);
for (let i = 0; i < samples; i++) {
  crypto.getRandomValues(buf);
  const h = toBase36(buf);
  for (const L of [1, 3, 4]) {
    const key = L === 1 ? h[0] : truncateHash(h, L);
    const m = counts.get(L)!;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
}
for (const L of [1, 3, 4]) {
  const m = counts.get(L)!;
  // unbiased estimator of sum p^2: sum c(c-1) / (n(n-1))
  let s = 0;
  for (const c of m.values()) s += c * (c - 1);
  const est = s / (samples * (samples - 1));
  console.log(`L=${L}: empirical sum p^2 = ${est.toExponential(4)}, exact = ${rows[L - 1].sumP2.toExponential(4)}`);
}
