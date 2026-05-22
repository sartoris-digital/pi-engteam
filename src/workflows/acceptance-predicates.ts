// Phase A item 8: per-step host-executed acceptance predicates.
// After an agent emits a PASS verdict, ADWEngine consults the
// step's `acceptPass` predicate to verify the verdict is supported
// by on-disk evidence the host can independently check (artifact
// exists + non-empty + has required sections; for synthesized
// verdicts, content fields cover the predicate's requirements).
//
// Synthesized verdicts are NON-AUTHORITATIVE for safety-gating
// steps — judge-gate / verify / security-auditor will refuse them
// regardless of content.
import { existsSync, readFileSync, statSync } from "fs";
import { isAbsolute, join } from "path";
import type { VerdictPayload } from "../types.js";

export type AcceptResult = {
  ok: boolean;
  reasons: string[];
};

export type AcceptContext = {
  verdict: VerdictPayload;
  runDir: string;
  stepName: string;
  // True when the verdict was synthesized by the orchestrator
  // (TeamRuntime artifact-validation block), not emitted directly
  // by the model. Set by ADWEngine when delivering the verdict to
  // the predicate.
  synthesized?: boolean;
  // Safety-gating step? Predicate uses this to refuse synthesized
  // PASS on judge-gate / verify / security-auditor steps.
  safetyGating?: boolean;
};

export type AcceptPredicate = (ctx: AcceptContext) => Promise<AcceptResult> | AcceptResult;

/**
 * Default predicate: every artifact in `verdict.artifacts` must
 * exist on disk under runDir/cwd with non-zero size and contain at
 * least one required-section heading from `opts.requiredSections`
 * (if any).
 */
export function defaultArtifactPredicate(opts: {
  requiredSections?: string[];
  minBytes?: number;
} = {}): AcceptPredicate {
  return ({ verdict, runDir, synthesized, safetyGating, stepName }) => {
    const reasons: string[] = [];
    if (verdict.verdict !== "PASS") return { ok: true, reasons: [] };
    if (synthesized && safetyGating) {
      reasons.push(
        `synthesized verdicts are non-authoritative for safety-gating step '${stepName}'; the agent must emit a real verdict via VerdictEmit or file-write.`,
      );
      return { ok: false, reasons };
    }
    const artifacts = verdict.artifacts ?? [];
    if (artifacts.length === 0) return { ok: true, reasons: [] };
    const minBytes = opts.minBytes ?? 1;
    for (const art of artifacts) {
      const candidates = isAbsolute(art)
        ? [art]
        : [join(runDir, art), art];
      let foundPath: string | undefined;
      for (const c of candidates) {
        if (existsSync(c)) {
          foundPath = c;
          break;
        }
      }
      if (!foundPath) {
        reasons.push(`artifact '${art}' does not exist on disk under runDir`);
        continue;
      }
      try {
        const st = statSync(foundPath);
        if (!st.isFile() || st.size < minBytes) {
          reasons.push(`artifact '${art}' is empty or not a regular file (size=${st.size})`);
          continue;
        }
      } catch {
        reasons.push(`artifact '${art}' could not be stat'd`);
        continue;
      }
      if (opts.requiredSections && opts.requiredSections.length > 0) {
        let content: string;
        try {
          content = readFileSync(foundPath, "utf8");
        } catch {
          reasons.push(`artifact '${art}' could not be read for required-section check`);
          continue;
        }
        for (const section of opts.requiredSections) {
          // Match `## Section`, `# Section`, or `### Section`.
          const re = new RegExp(`^#{1,3}\\s+${section.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`, "im");
          if (!re.test(content)) {
            reasons.push(`artifact '${art}' missing required section '${section}'`);
          }
        }
      }
    }
    return { ok: reasons.length === 0, reasons };
  };
}

/**
 * Predicate that always passes — useful when a step prompts for
 * analysis without requiring artifact files.
 */
export const passThrough: AcceptPredicate = () => ({ ok: true, reasons: [] });
