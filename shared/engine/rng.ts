/**
 * Controlled randomness for the engine. No `Math.random` anywhere in the engine:
 * every random number comes from a Mulberry32 stream derived from the run seed.
 */
export type Rng = () => number;

/** Mulberry32 PRNG: uniform on [0, 1), deterministic for a given 32-bit seed. */
export function mulberry32(seed: number): Rng {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Seed of an independent named substream (e.g. "M", "W").
 * Separate streams give common random numbers across modes: the M draws of mode 4
 * equal those of mode 2, and the W draws of mode 4 equal those of mode 3.
 */
export function deriveSeed(seed: number, stream: string): number {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (let i = 0; i < stream.length; i++) {
    h ^= stream.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h ^ Math.imul(seed >>> 0, 0x9e3779b1));
}

export function substream(seed: number, stream: string): Rng {
  return mulberry32(deriveSeed(seed, stream));
}

/** Exponential(1) via inversion; 1 - U lies in (0, 1]. */
export function exponential(rng: Rng): number {
  return -Math.log(1 - rng());
}

/** Standard normal via Box–Muller (consumes exactly two uniforms). */
export function standardNormal(rng: Rng): number {
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Gamma(shape, 1): Marsaglia–Tsang (2000); shape < 1 via the boost Gamma(a+1)·U^(1/a). */
export function gamma(rng: Rng, shape: number): number {
  if (!(shape > 0)) throw new RangeError('gamma shape must be > 0');
  if (shape < 1) {
    const g = gamma(rng, shape + 1);
    return g * Math.pow(1 - rng(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = standardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = 1 - rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Inverse CDF of the triangular distribution (a ≤ c ≤ b) at u ∈ [0, 1). */
export function triangularInv(u: number, a: number, c: number, b: number): number {
  if (b <= a) return a;
  const f = (c - a) / (b - a);
  if (u < f) return a + Math.sqrt(u * (b - a) * (c - a));
  return b - Math.sqrt((1 - u) * (b - a) * (b - c));
}

/** Index from a cumulative probability table (last entry treated as 1). */
export function pickCumulative(u: number, cumulative: number[]): number {
  for (let i = 0; i < cumulative.length - 1; i++) if (u < cumulative[i]) return i;
  return cumulative.length - 1;
}
