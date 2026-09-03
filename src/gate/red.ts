import type { Workspace } from "../workspace/types.js";
import type { JunitReport } from "./junit.js";

export type RedEscalation = "gate-invalid" | "gate-baseline-green";

export interface RedResult {
  ok: boolean;
  escalate?: RedEscalation;
  detail: string;
  red: string[];
  green: string[];
  errored: string[];
  skipped: string[];
  missing: string[];
}

function normalizeId(id: string, wsPath: string): string {
  const prefix = wsPath.endsWith("/") ? wsPath : `${wsPath}/`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

export function verifyRedBaseline(ws: Workspace, gateTestIds: string[], report: JunitReport): RedResult {
  const ids = [...new Set(gateTestIds.map((id) => normalizeId(id.trim(), ws.path)))].filter((id) => id.length > 0);
  const red: string[] = [];
  const green: string[] = [];
  const errored: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];
  const byId = new Map(report.cases.map((c) => [c.id, c] as const));

  for (const id of ids) {
    const c = byId.get(id);
    if (c === undefined) {
      missing.push(id);
      continue;
    }
    if (c.status === "failed") red.push(id);
    else if (c.status === "passed") green.push(id);
    else if (c.status === "error") errored.push(id);
    else skipped.push(id);
  }

  const buckets = { red, green, errored, skipped, missing };
  if (ids.length === 0) {
    return { ok: false, escalate: "gate-invalid", detail: "no gate test ids declared", ...buckets };
  }
  if (report.collectionErrors.length > 0) {
    return {
      ok: false,
      escalate: "gate-invalid",
      detail: `collection errors: ${report.collectionErrors.join(", ")}`,
      ...buckets,
    };
  }
  if (missing.length > 0 || errored.length > 0 || skipped.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing from report: ${missing.join(", ")}`);
    if (errored.length > 0) parts.push(`errored instead of failed: ${errored.join(", ")}`);
    if (skipped.length > 0) parts.push(`skipped: ${skipped.join(", ")}`);
    return { ok: false, escalate: "gate-invalid", detail: parts.join("; "), ...buckets };
  }
  if (green.length > 0) {
    return {
      ok: false,
      escalate: "gate-baseline-green",
      detail: `gate tests pass before implementation: ${green.join(", ")}`,
      ...buckets,
    };
  }
  return { ok: true, detail: `${red.length} gate test(s) fail as required`, ...buckets };
}
