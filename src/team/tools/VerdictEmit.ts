import { defineTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { VerdictPayload } from "../../types.js";

// Module-level flag prevents a second VerdictEmit call from stacking another
// exit timer if an agent retries or fires the tool twice. First verdict wins
// the timer; later calls still write the verdict file (last-writer-wins) but
// do not reschedule the exit. Codex round-1 #3.
let exitScheduled = false;

export function createVerdictEmitTool(onVerdict: (v: VerdictPayload) => void) {
  return defineTool({
    name: "VerdictEmit",
    label: "Emit Verdict",
    description: "Emit a structured verdict for the current workflow step. Call this at the end of every turn. PASS = complete and correct. FAIL = issues found (list them in issues). NEEDS_MORE = need more information. PARTIAL = verifier-style result: some claims unverifiable but no failures (gaps logged for the Learner).",
    parameters: Type.Object({
      step: Type.String({ description: "Step name this verdict applies to, e.g. 'build', 'review'" }),
      verdict: Type.Union([
        Type.Literal("PASS"),
        Type.Literal("FAIL"),
        Type.Literal("NEEDS_MORE"),
        Type.Literal("PARTIAL"),
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
      // Phase 5 §8.3 wisdom fields — fed into per-agent expertise files
      // by Memory Core's flushExpertise. Workers emit these to compound
      // expertise across runs; agents never edit expertise files directly.
      learnings: Type.Optional(Type.Array(Type.String(), {
        description: "Concrete lessons learned. One short statement per item.",
      })),
      decisions: Type.Optional(Type.Array(Type.String(), {
        description: "Decisions made during this step (and why) worth remembering.",
      })),
      issues_found: Type.Optional(Type.Array(Type.String(), {
        description: "Issues observed but not necessarily blocking — useful for future runs.",
      })),
      gotchas: Type.Optional(Type.Array(Type.String(), {
        description: "Surprising behaviors / sharp edges future agents should watch for.",
      })),
    }),
    execute: async (_id, params) => {
      // Write verdict to file for subprocess mode (PI_ENGINEERING_VERDICT_FILE)
      const verdictFile = process.env["PI_ENGINEERING_VERDICT_FILE"];
      if (verdictFile) {
        const { writeFileSync } = await import("fs");
        writeFileSync(verdictFile, JSON.stringify(params));
      }
      onVerdict(params);

      // Subprocess-mode fast-exit. The agent subprocess has fulfilled its sole
      // purpose: the verdict file is on disk and TeamRuntime is waiting for
      // `proc.on("close", …)` to fire. Pi `-p` mode does not consistently exit
      // after the assistant's final tool call when our extension keeps any
      // handles open (the per-subprocess Vault SQLite connection, secret
      // resolver event sinks, the tool_call hook, etc.), so without this hook
      // every step burns the full 10-minute kill timeout in TeamRuntime.
      //
      // Gate on the full subprocess-identity triple — agent mode flag, the
      // verdict file path, and the agent name — so the controller Pi process
      // can never trip this exit even if PI_ENGINEERING_AGENT_MODE leaks into
      // its environment (Codex round-1 #1). Vault cleanup is handled by the
      // process.on("exit") hook registered in src/index.ts's subprocess
      // branch (Codex round-1 #5). 250ms grace lets Pi flush its final
      // assistant response to stdout (Codex round-1 #2/#7).
      const isAgent =
        process.env["PI_ENGINEERING_AGENT_MODE"] === "1" &&
        !!verdictFile &&
        !!process.env["PI_ENGINEERING_AGENT_NAME"];
      if (isAgent && !exitScheduled) {
        exitScheduled = true;
        setTimeout(() => process.exit(0), 250);
      }

      return {
        content: [{ type: "text" as const, text: `Verdict recorded: ${params.verdict}` }],
        details: {},
      };
    },
    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const color = args.verdict === "PASS" ? "success" : args.verdict === "FAIL" ? "error" : "warning";
      const issues = args.issues?.length ? `  (${args.issues.length} issue${args.issues.length === 1 ? "" : "s"})` : "";
      text.setText(`${theme.fg(color, args.verdict)}  [${args.step}]${issues}`);
      return text;
    },
    renderResult(result, _options, _theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(
        result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map(c => c.text)
          .join(""),
      );
      return text;
    },
  });
}
