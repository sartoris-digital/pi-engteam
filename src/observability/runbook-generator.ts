// Phase E item E1 — runbook Markdown generated from the catalog.
//
// The runbook is auto-emitted from `metric-catalog.ts`. Hand-editing
// is forbidden — `docs/runbooks/observability.md` is regenerated on
// every build by `scripts/generate-runbook.mjs`. CI fails when the
// emitted output differs from what's checked in.
//
// Per round 11 LOW: every threshold expression declares its
// aggregation rule explicitly. The generator surfaces that
// alongside the alert expression.
import { METRIC_CATALOG, type MetricEntry } from "./metric-catalog.js";

const HEADER = `# pi-engineering observability runbook

> GENERATED FILE — do not edit. Source of truth is
> \`src/observability/metric-catalog.ts\`. Regenerate via
> \`pnpm runbook\` (CI verifies the diff is empty).

This runbook is the on-call reference for every metric the
pi-engineering runtime emits. Each entry includes: catalog name,
type, labels, units, alert expression, runbook action.
`;

function entrySection(e: MetricEntry): string {
  const lines: string[] = [];
  lines.push(`## \`${e.name}\``);
  lines.push("");
  lines.push(`- **Type:** \`${e.type}\``);
  lines.push(`- **Unit:** \`${e.unit}\``);
  lines.push(`- **Labels:** ${e.labels.length === 0 ? "_(none)_" : e.labels.map((l) => `\`${l}\``).join(", ")}`);
  lines.push(`- **Description:** ${e.description}`);
  if (e.alertExpr) {
    lines.push(`- **Alert (window ${e.alertWindow ?? "n/a"}):**`);
    lines.push("");
    lines.push("  ```promql");
    lines.push("  " + e.alertExpr);
    lines.push("  ```");
  }
  if (e.runbook) {
    lines.push(`- **Runbook:** ${e.runbook}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the full runbook Markdown from the catalog. Sections are
 * sorted by metric name for stable diffs.
 */
export function generateRunbook(): string {
  const names = Object.keys(METRIC_CATALOG).sort();
  const sections = names.map((n) => entrySection(METRIC_CATALOG[n]));
  return [HEADER, ...sections].join("\n");
}
