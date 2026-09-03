import type { FusionSlot } from "./types.js";

export type StackValidation =
  | { ok: true; warning?: string }
  | { ok: false; error: string; warning?: string };

/** Vendor prefix is the substring before the first `/`; the whole id if none. */
export function vendorPrefix(model: string): string {
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(0, slash);
}

export function validateStack(stack: FusionSlot[]): StackValidation {
  const seen = new Set<string>();
  for (const slot of stack) {
    if (seen.has(slot.model)) {
      return { ok: false, error: `duplicate model id ${slot.model}` };
    }
    seen.add(slot.model);
  }
  const byVendor = new Map<string, number>();
  for (const slot of stack) {
    const vendor = vendorPrefix(slot.model);
    byVendor.set(vendor, (byVendor.get(vendor) ?? 0) + 1);
  }
  const repeated = [...byVendor.entries()].filter(([, n]) => n > 1).map(([v]) => v);
  if (repeated.length === 0) return { ok: true };
  return { ok: true, warning: `same vendor prefix ${repeated.join(", ")} appears more than once` };
}
