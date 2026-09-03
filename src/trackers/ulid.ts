import { randomBytes } from "node:crypto";

/** Crockford base32: no I, L, O, U. Sorts lexicographically in ASCII order. */
export const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const TIME_MAX = 2 ** 48 - 1;
const RANDOM_MAX = (1n << 80n) - 1n;

export function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > TIME_MAX) {
    throw new RangeError(`ulid: time out of range: ${ms}`);
  }
  let out = "";
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = ULID_ALPHABET.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

export function decodeTime(id: string): number {
  if (!ULID_PATTERN.test(id)) throw new Error(`ulid: malformed id: ${id}`);
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + ULID_ALPHABET.indexOf(ch);
  return t;
}

function encodeRandom(r: bigint): string {
  let out = "";
  let v = r;
  for (let i = 0; i < 16; i++) {
    out = ULID_ALPHABET.charAt(Number(v & 31n)) + out;
    v >>= 5n;
  }
  return out;
}

/**
 * Monotonic ULID factory. Within one millisecond (or when the clock steps
 * backwards) the 80-bit random component is incremented instead of redrawn,
 * so ids from one generator always sort in creation order.
 */
export function createUlidGenerator(now: () => number = Date.now): () => string {
  let lastMs = -1;
  let lastRandom = 0n;
  return () => {
    let ms = now();
    if (ms <= lastMs) {
      ms = lastMs;
      lastRandom += 1n;
      if (lastRandom > RANDOM_MAX) throw new RangeError("ulid: random component overflow");
    } else {
      lastMs = ms;
      lastRandom = BigInt("0x" + randomBytes(10).toString("hex"));
    }
    return encodeTime(ms) + encodeRandom(lastRandom);
  };
}

export const ulid: () => string = createUlidGenerator();
