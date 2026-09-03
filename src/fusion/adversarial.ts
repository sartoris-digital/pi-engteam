import type { StepResult } from "../engine/types.js";
import type { SlotResult } from "./types.js";

interface Finding {
  id: string;
  citation?: string;
}

interface AdversarialReport {
  findings?: Finding[];
  confirmed?: Finding[];
  refuted?: Finding[];
  missed?: Finding[];
}

function parseReport(text: string): AdversarialReport {
  try {
    const raw: unknown = JSON.parse(text);
    if (raw && typeof raw === "object") return raw as AdversarialReport;
  } catch {
    /* not JSON */
  }
  return {};
}

export function mergeAdversarial(slots: SlotResult[]): StepResult {
  const a = slots[0];
  const b = slots[1];
  const producer = parseReport(a?.text ?? "");
  const refuter = parseReport(b?.text ?? "");
  const aFindings = producer.findings ?? [];
  const confirmedIds = new Set((refuter.confirmed ?? []).map((f) => f.id));
  const issues: string[] = [];
  for (const finding of aFindings) {
    if (confirmedIds.has(finding.id)) {
      issues.push(`blocking:${finding.id}${finding.citation ? ` ${finding.citation}` : ""}`);
      continue;
    }
    if (finding.citation) issues.push(`a-only:${finding.id} ${finding.citation}`);
  }
  for (const missed of refuter.missed ?? []) {
    issues.push(`missed:${missed.id}${missed.citation ? ` ${missed.citation}` : ""}`);
  }
  const blocking = issues.some((i) => i.startsWith("blocking:"));
  return { verdict: blocking ? "FAIL" : "PASS", ...(issues.length > 0 ? { issues } : {}) };
}
