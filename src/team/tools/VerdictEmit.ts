import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { VerdictPayload } from "../../types.js";

export function createVerdictEmitTool(onVerdict: (v: VerdictPayload) => void) {
  return defineTool({
    name: "VerdictEmit",
    label: "Emit Verdict",
    description: "Emit a structured verdict for the current workflow step. Call this at the end of every turn. PASS = complete and correct. FAIL = issues found (list them in issues). NEEDS_MORE = need more information.",
    parameters: Type.Object({
      step: Type.String({ description: "Step name this verdict applies to, e.g. 'build', 'review'" }),
      verdict: Type.Union([
        Type.Literal("PASS"),
        Type.Literal("FAIL"),
        Type.Literal("NEEDS_MORE"),
      ], { description: "Verdict value" }),
      issues: Type.Optional(Type.Array(Type.String(), {
        description: "List of specific issues found (required when verdict is FAIL)",
      })),
      artifacts: Type.Optional(Type.Array(Type.String(), {
        description: "File paths to artifacts produced in this step",
      })),
      handoffHint: Type.Optional(Type.String({
        description: "Routing hint for failure escalation: 'security'|'perf'|'re-plan'",
      })),
    }),
    execute: async (_id, params) => {
      onVerdict(params);
      return {
        content: [{ type: "text" as const, text: `Verdict recorded: ${params.verdict}` }],
        details: {},
      };
    },
  });
}
