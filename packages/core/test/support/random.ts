// A deterministic `() => number` for the property tests, adapted from Agentic Marketing's
// `test-support/index.ts` (the same Mulberry32 generator and a fixed default seed). The server's
// label declares nothing but the seed; a failing run can be replayed with `ASEO_TEST_SEED`.

/** The seed used when `ASEO_TEST_SEED` is absent. Fixed, so a clean checkout is reproducible. */
export const DEFAULT_TEST_SEED = 0x5eed_1234;

/** The seed for this run. `ASEO_TEST_SEED` overrides the fixed default. */
export function testSeed(): number {
  const raw = process.env.ASEO_TEST_SEED;
  if (raw === undefined || raw === '') return DEFAULT_TEST_SEED;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new Error(`ASEO_TEST_SEED must be an integer between 0 and 4294967295, received ${JSON.stringify(raw)}`);
  }
  return parsed >>> 0;
}

/** Mulberry32: a small, fast, deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A deterministic `() => number` in `[0, 1)`, seeded from `ASEO_TEST_SEED` unless a seed is passed. */
export function seededRandom(seed: number = testSeed()): () => number {
  return mulberry32(seed);
}
