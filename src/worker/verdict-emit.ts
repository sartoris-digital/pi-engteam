import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { generatedMarker } from "../runtime/marker.js";
import { VerdictPayloadSchema, VERDICT_MAX_BYTES, type VerdictPayload } from "../runtime/types.js";

export const VERDICT_EMIT_TOOL_NAME = "VerdictEmit";
export const DEFAULT_EXIT_DELAY_MS = 250;

export interface VerdictEmitOptions {
  verdictFile: string;
  expectedStep: string;
  runId: string;
  exit?: (code: number) => void;
  exitDelayMs?: number;
}

export interface VerdictEmitDetails {
  path: string;
  verdict: VerdictPayload["verdict"];
  duplicate: boolean;
}

export function createVerdictEmitTool(opts: VerdictEmitOptions): ToolDefinition<typeof VerdictPayloadSchema, VerdictEmitDetails> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let emitted: VerdictPayload | null = null;
  let exitScheduled = false;
  const scheduleExit = (): void => {
    if (exitScheduled) return;
    exitScheduled = true;
    setTimeout(() => exit(0), opts.exitDelayMs ?? DEFAULT_EXIT_DELAY_MS);
  };

  return {
    name: VERDICT_EMIT_TOOL_NAME,
    label: "Verdict",
    description: `Record the final verdict for this step. Call it exactly once, as your last action, with step="${opts.expectedStep}". The session ends right after.`,
    promptSnippet: "Emit the step verdict (PASS / FAIL / NEEDS_MORE); required final action of every step",
    promptGuidelines: [
      `Every step must end with a VerdictEmit call with step="${opts.expectedStep}"; text printed as a verdict does not count.`,
    ],
    parameters: VerdictPayloadSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (emitted !== null) {
        return {
          content: [{ type: "text", text: `Verdict already recorded (${emitted.verdict}); no further action is needed.` }],
          details: { path: opts.verdictFile, verdict: emitted.verdict, duplicate: true },
          terminate: true,
        };
      }
      const cleaned = Value.Clean(VerdictPayloadSchema, structuredClone(params));
      if (!Value.Check(VerdictPayloadSchema, cleaned)) {
        const errors = Value.Errors(VerdictPayloadSchema, cleaned).map((e) => `${e.instancePath || "/"}: ${e.message}`);
        throw new Error(`VerdictEmit: payload failed schema validation: ${errors.join("; ")}`);
      }
      if (cleaned.step !== opts.expectedStep) {
        throw new Error(`VerdictEmit: step must be "${opts.expectedStep}", got "${cleaned.step}"`);
      }
      const text = `${JSON.stringify({ _marker: generatedMarker(opts.runId), ...cleaned }, null, 2)}\n`;
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > VERDICT_MAX_BYTES) {
        throw new Error(`VerdictEmit: payload exceeds ${VERDICT_MAX_BYTES} bytes (${bytes}); shorten issues/learnings`);
      }
      await mkdir(dirname(opts.verdictFile), { recursive: true });
      const tmp = `${opts.verdictFile}.${process.pid}.tmp`;
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, opts.verdictFile);
      emitted = cleaned;
      scheduleExit();
      return {
        content: [{ type: "text", text: `Verdict ${cleaned.verdict} recorded for step "${cleaned.step}". The session will now end.` }],
        details: { path: opts.verdictFile, verdict: cleaned.verdict, duplicate: false },
        terminate: true,
      };
    },
  };
}
