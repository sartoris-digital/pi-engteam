export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** True for `{}`-style objects only: not null, not an array, not a class instance. */
export function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deterministic JSON text: object keys sorted at every depth, no whitespace,
 * `undefined` object members dropped (array holes become null), so two
 * structurally equal configs hash to the same sha regardless of key order.
 *
 * The single canonicaliser for the whole factory: `src/safety/evidence-sign.ts`
 * (HMAC over evidence) and `src/lanes/compile.ts` (lane digests) import this
 * function instead of defining their own, so signatures and shas always agree.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}
