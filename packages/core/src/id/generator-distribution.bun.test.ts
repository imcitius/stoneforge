/**
 * el-4rgbi0: regression tests for the ID hash digit distribution and the
 * default hash length.
 *
 * Background (el-45m5h, docs/workspace/id-base36-bias-el-45m5h/): generateId
 * used to take the leading L characters of toBase36(SHA-256). Because
 * 36^49 < 2^256 < 36^50 that skews the first character (`0` never, `1..5`
 * ~16% each) and makes prefix pair collisions ~5.05x more likely than uniform
 * for L = 3..8. generateId now uses the low-order L digits (D mod 36^L,
 * zero-padded).
 *
 * The statistical checks run on deterministic digests (SHA-256 of a fixed
 * counter sequence), so results are reproducible and cannot flake: the stated
 * tolerances document the margin between the measured value and uniform, and
 * a negative control shows the same check rejects the old leading-digit method.
 */
import { describe, expect, test } from 'bun:test';
import type { EntityId } from '../types/element.js';
import {
  BASE36_CHARS,
  DEFAULT_HASH_LENGTH,
  MAX_HASH_LENGTH,
  MIN_HASH_LENGTH,
  ROOT_ID_PATTERN,
  calculateIdLength,
  generateId,
  generateIdHashDigits,
  parseId,
  sha256,
  toBase36,
  toBase36Digits,
  truncateHash,
  type IdComponents,
} from './generator.js';

const TWO256 = 1n << 256n;
const pow36 = (k: number): bigint => 36n ** BigInt(k);

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function bigIntToBytes32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** Independent reference: (D mod 36^L) in base36, zero-padded to L */
function referenceLowDigits(bytes: Uint8Array, length: number): string {
  return (bytesToBigInt(bytes) % pow36(length)).toString(36).padStart(length, '0');
}

/** Deterministic digests: SHA-256("el-4rgbi0-seed|" + i) for i = 0..count-1 */
async function seededDigests(count: number): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    out.push(await sha256(`el-4rgbi0-seed|${i}`));
  }
  return out;
}

/** Pearson chi-square of observed counts against a uniform expectation */
function chiSquareUniform(counts: number[], total: number): number {
  const expected = total / counts.length;
  return counts.reduce((s, c) => s + ((c - expected) * (c - expected)) / expected, 0);
}

/** Unbiased estimate of sum p^2 (pair-collision probability): sum c(c-1)/(n(n-1)) */
function pairCollisionEstimate(keys: string[]): number {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  let s = 0;
  for (const c of counts.values()) s += c * (c - 1);
  return s / (keys.length * (keys.length - 1));
}

const SAMPLE_COUNT = 20000;
const digestsPromise = seededDigests(SAMPLE_COUNT);

// ============================================================================
// toBase36Digits contract
// ============================================================================

describe('toBase36Digits (low-order fixed-length digits)', () => {
  test('zero-pads to exactly L characters', () => {
    expect(toBase36Digits(new Uint8Array([0]), 3)).toBe('000');
    expect(toBase36Digits(new Uint8Array([35]), 4)).toBe('000z');
    expect(toBase36Digits(new Uint8Array([1, 0]), 3)).toBe('074'); // 256
  });

  test('keeps the LOW-order digits, not the leading ones', () => {
    // 36^5 + 1 = "100001" in base36: low 3 digits "001", leading 3 digits "100"
    const bytes = bigIntToBytes32(pow36(5) + 1n);
    expect(toBase36(bytes)).toBe('100001');
    expect(toBase36Digits(bytes, 3)).toBe('001');
    expect(truncateHash(toBase36(bytes), 3)).toBe('100');
  });

  test('clamps length to [MIN_HASH_LENGTH, MAX_HASH_LENGTH]', () => {
    const bytes = bigIntToBytes32(TWO256 - 1n);
    expect(toBase36Digits(bytes, 1)).toHaveLength(MIN_HASH_LENGTH);
    expect(toBase36Digits(bytes, 100)).toHaveLength(MAX_HASH_LENGTH);
  });

  test('matches independent (D mod 36^L) reference for seeded digests', async () => {
    const digests = await digestsPromise;
    for (const d of digests.slice(0, 500)) {
      for (let L = MIN_HASH_LENGTH; L <= MAX_HASH_LENGTH; L++) {
        const digits = toBase36Digits(d, L);
        expect(digits).toBe(referenceLowDigits(d, L));
        expect(ROOT_ID_PATTERN.test(`el-${digits}`)).toBe(true);
      }
    }
  });

  test('a longer length extends the same low-order digits', async () => {
    const [d] = await digestsPromise;
    for (let L = MIN_HASH_LENGTH; L < MAX_HASH_LENGTH; L++) {
      expect(toBase36Digits(d, L + 1).endsWith(toBase36Digits(d, L))).toBe(true);
    }
  });
});

describe('generateIdHashDigits determinism', () => {
  const components: IdComponents = {
    identifier: 'Task',
    createdBy: 'el-user1' as EntityId,
    timestampNs: 1735689600000000000n,
    nonce: 0,
  };

  test('identical components give identical digits', async () => {
    for (let L = MIN_HASH_LENGTH; L <= MAX_HASH_LENGTH; L++) {
      const a = await generateIdHashDigits(components, L);
      const b = await generateIdHashDigits({ ...components }, L);
      expect(a).toBe(b);
      expect(a).toHaveLength(L);
    }
  });

  test('equals low-order digits of SHA-256 over the documented input', async () => {
    const digest = await sha256('Task|el-user1|1735689600000000000|0');
    expect(await generateIdHashDigits(components, 6)).toBe(referenceLowDigits(digest, 6));
  });

  test('nonce changes the digits', async () => {
    const a = await generateIdHashDigits(components, 8);
    const b = await generateIdHashDigits({ ...components, nonce: 1 }, 8);
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// Exact distribution checks (BigInt, uniform 256-bit digest model)
// ============================================================================

describe('exact distribution (uniform SHA-256 model)', () => {
  test('low-order digits: relative pair-collision excess is r(M-r)/2^512 < 1e-130 for L=3..8', () => {
    for (let L = MIN_HASH_LENGTH; L <= MAX_HASH_LENGTH; L++) {
      const M = pow36(L);
      const q = TWO256 / M;
      const r = TWO256 % M;
      // r residues occur q+1 times, M-r residues occur q times
      const sumSq = r * (q + 1n) * (q + 1n) + (M - r) * q * q;
      const excessNum = M * sumSq - TWO256 * TWO256;
      expect(excessNum).toBe(r * (M - r));
      const relativeExcess = Number(excessNum) / 2 ** 512;
      expect(relativeExcess).toBeGreaterThanOrEqual(0);
      expect(relativeExcess).toBeLessThan(1e-130);
    }
  });

  test('low-order digits: every first character, including 0, has probability 1/36 within 1e-60', () => {
    for (const L of [3, 6, 8]) {
      const M = pow36(L);
      const block = pow36(L - 1); // residues per first character
      const q = TWO256 / M;
      const r = TWO256 % M;
      for (let d = 0n; d < 36n; d++) {
        const lo = d * block;
        const hi = lo + block;
        const extra = r <= lo ? 0n : (r >= hi ? block : r - lo);
        const count = block * q + extra;
        // |count/2^256 - 1/36| = |36*count - 2^256| / (36 * 2^256)
        const diff = 36n * count - TWO256;
        const absDiff = diff < 0n ? -diff : diff;
        expect(Number(absDiff) / 36 / 2 ** 256).toBeLessThan(1e-60);
      }
    }
  });

  test('negative control: old leading-digit method is ~5.05x uniform for L=3..8', () => {
    // Exact prefix counts for the previous truncateHash(toBase36(D), L): see
    // docs/workspace/id-base36-bias-el-45m5h/README.md for the derivation.
    for (let L = MIN_HASH_LENGTH; L <= MAX_HASH_LENGTH; L++) {
      let A = 0n;
      for (let n = L; n <= 49; n++) A += pow36(n - L);
      const full50 = pow36(50 - L);
      const T = TWO256 / full50;
      const partial = TWO256 - T * full50;
      const lo = pow36(L - 1);
      const hi = pow36(L);
      const nBig = T - lo;
      const nSmall = hi - T - 1n;
      const cBig = A + full50;
      const cT = A + partial;
      const total = nBig * cBig + cT + nSmall * A;
      expect(total).toBe(TWO256 - lo);
      const sumSq = nBig * cBig * cBig + cT * cT + nSmall * A * A;
      const SCALE = 10n ** 12n;
      const ratio = Number((sumSq * hi * SCALE) / (total * total)) / 1e12;
      expect(ratio).toBeGreaterThan(5.05);
      expect(ratio).toBeLessThan(5.06);
    }
  });
});

// ============================================================================
// Seeded Monte-Carlo checks (deterministic digests)
// ============================================================================

describe('seeded first-character / prefix distribution', () => {
  // 20,000 deterministic digests; 36 first-char buckets (~556 each).
  // Chi-square with 35 degrees of freedom: mean 35, P(X > 70) ≈ 4e-4 for a
  // truly uniform source. The old method scores ~77,000 (n·(36·Σp²−1)).
  const CHI_SQUARE_LIMIT = 70;
  // Pair-collision estimate relative to uniform 36^-L: uniform sampling noise
  // is ~3% (L=2) and ~1.5% relative SD of pair counts at L=3 with n=20,000;
  // tolerance ±15%. The old method measures ~5.05.
  const RATIO_TOLERANCE = 0.15;

  test('first character is near uniform for L = 3, 6 and 8', async () => {
    const digests = await digestsPromise;
    for (const L of [3, 6, 8]) {
      const counts = new Array<number>(36).fill(0);
      for (const d of digests) {
        counts[BASE36_CHARS.indexOf(toBase36Digits(d, L)[0])]++;
      }
      expect(counts.every((c) => c > 0)).toBe(true); // includes leading '0'
      expect(chiSquareUniform(counts, digests.length)).toBeLessThan(CHI_SQUARE_LIMIT);
    }
  });

  test('negative control: old leading-digit method fails the same first-character check', async () => {
    const digests = await digestsPromise;
    const counts = new Array<number>(36).fill(0);
    for (const d of digests) {
      counts[BASE36_CHARS.indexOf(truncateHash(toBase36(d), 3)[0])]++;
    }
    expect(counts[0]).toBe(0); // leading '0' unreachable
    expect(chiSquareUniform(counts, digests.length)).toBeGreaterThan(100 * CHI_SQUARE_LIMIT);
  });

  test('prefix pair-collision probability is within ±15% of uniform for L = 2 and 3', async () => {
    const digests = await digestsPromise;
    for (const L of [2, 3]) {
      const keys = digests.map((d) => referenceLowDigits(d, 8).slice(0, L));
      const ratio = pairCollisionEstimate(keys) * Number(pow36(L));
      expect(Math.abs(ratio - 1)).toBeLessThan(RATIO_TOLERANCE);
    }
    // Full generateId-length hash (L = 3) via the production helper
    const keys3 = digests.map((d) => toBase36Digits(d, 3));
    const ratio3 = pairCollisionEstimate(keys3) * Number(pow36(3));
    expect(Math.abs(ratio3 - 1)).toBeLessThan(RATIO_TOLERANCE);
  });

  test('generateId output first character is not skewed (end-to-end, loose bound)', async () => {
    // generateId timestamps are not reproducible, so this uses a very loose
    // bound: for uniform digits P(chi-square_35 > 200) < 1e-23, while the old
    // leading-digit method gives ~7,700 at n = 2,000 (n·(36·Σp²−1), Σp² ≈ 0.1346) and never emits '0'.
    const n = 2000;
    const counts = new Array<number>(36).fill(0);
    for (let i = 0; i < n; i++) {
      const id = await generateId(
        { identifier: `Distribution ${i}`, createdBy: 'el-user1' as EntityId },
        { hashLength: 3 }
      );
      counts[BASE36_CHARS.indexOf(parseId(id).hash[0])]++;
    }
    expect(chiSquareUniform(counts, n)).toBeLessThan(200);
  });

  test('negative control: old leading-digit method shows ~5x pair collisions at L = 3', async () => {
    const digests = await digestsPromise;
    const keys = digests.map((d) => truncateHash(toBase36(d), 3));
    const ratio = pairCollisionEstimate(keys) * Number(pow36(3));
    expect(ratio).toBeGreaterThan(4);
    expect(ratio).toBeLessThan(6);
  });
});

// ============================================================================
// Default hash length
// ============================================================================

describe('generateId default hash length', () => {
  const createdBy = 'el-user1' as EntityId;

  test('DEFAULT_HASH_LENGTH is 6 and inside the root ID pattern bounds', () => {
    expect(DEFAULT_HASH_LENGTH).toBe(6);
    expect(DEFAULT_HASH_LENGTH).toBeGreaterThanOrEqual(MIN_HASH_LENGTH);
    expect(DEFAULT_HASH_LENGTH).toBeLessThanOrEqual(MAX_HASH_LENGTH);
  });

  test('no config uses 6 characters', async () => {
    for (let i = 0; i < 20; i++) {
      const id = await generateId({ identifier: `Default ${i}`, createdBy });
      expect(ROOT_ID_PATTERN.test(id)).toBe(true);
      expect(parseId(id).hash).toHaveLength(DEFAULT_HASH_LENGTH);
    }
  });

  test('config without hashLength/elementCount (collision check only) uses 6 characters', async () => {
    const id = await generateId({ identifier: 'Checked', createdBy }, { checkCollision: () => false });
    expect(parseId(id).hash).toHaveLength(DEFAULT_HASH_LENGTH);
  });

  test('elementCount keeps adaptive length (unchanged)', async () => {
    for (const count of [0, 99, 100, 499, 500, 2999, 3000, 19999, 20000, 99999, 100000]) {
      const id = await generateId({ identifier: 'Adaptive', createdBy }, { elementCount: count });
      expect(parseId(id).hash).toHaveLength(calculateIdLength(count));
    }
  });

  test('explicit hashLength wins over default and elementCount', async () => {
    const id = await generateId(
      { identifier: 'Explicit', createdBy },
      { hashLength: 4, elementCount: 100000 }
    );
    expect(parseId(id).hash).toHaveLength(4);
  });

  test('length increase after nonce exhaustion still applies from the default', async () => {
    const id = await generateId(
      { identifier: 'Escalate', createdBy },
      { checkCollision: (candidate) => parseId(candidate).hash.length === DEFAULT_HASH_LENGTH }
    );
    expect(parseId(id).hash).toHaveLength(DEFAULT_HASH_LENGTH + 1);
  });
});
