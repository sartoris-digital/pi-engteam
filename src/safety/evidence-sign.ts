import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../config/json.js";

export function signRecord(obj: Record<string, unknown>, secret: string): string {
  return createHmac("sha256", secret).update(canonicalJson(obj)).digest("hex");
}

export function verifyRecord(obj: Record<string, unknown>, sig: string, secret: string): boolean {
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = signRecord(obj, secret);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
