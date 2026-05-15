// src/commands/issue.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ADWEngine } from "../adw/ADWEngine.js";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { AgentDefinition } from "../types.js";
import { readFile } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";
import { detectTracker } from "./issue-tracker.js";
import { executeSpecWorkflow } from "./spec.js";

// Codex round-1 finding #8: when /issue is invoked against a github ticket we
// run gh inside the analyze worker. If gh is missing or unauthenticated the
// worker fails 5 steps deep with a generic error and the user has to dig
// through events.jsonl to find out why. Preflighting `gh auth status` here
// surfaces the real cause immediately and points at the fix (`gh auth login`).
async function checkGhAuth(): Promise<
  { ok: true } | { ok: false; reason: "missing-binary" | "unauthenticated" | "error"; detail: string }
> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("gh", ["auth", "status"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, reason: "missing-binary", detail: String(err) });
      return;
    }
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        resolve({ ok: false, reason: "missing-binary", detail: "gh CLI not found on PATH" });
      } else {
        resolve({ ok: false, reason: "error", detail: err.message });
      }
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        const out = (stderr + stdout).trim();
        resolve({ ok: false, reason: "unauthenticated", detail: out || `gh auth status exited ${code}` });
      }
    });
  });
}

export function parseIssueArgs(raw: string): { ticketRef: string; trackerFlag?: string } {
  const trackerMatch = raw.match(/--tracker\s+(github|ado|jira)/);
  const trackerFlag = trackerMatch?.[1];
  const ticketRef = raw.replace(/--tracker\s+\S+/, "").trim();
  return { ticketRef, trackerFlag };
}

export function parseBrief(text: string): { suggestedWorkflow: string; goal: string } | null {
  const workflowMatch = text.match(/^## Suggested Workflow\s*\n(.+)/m);
  const goalMatch = text.match(/^## Goal\s*\n(.+)/m);
  if (!workflowMatch || !goalMatch) return null;
  return {
    suggestedWorkflow: workflowMatch[1].trim(),
    goal: goalMatch[1].trim(),
  };
}

export function registerIssueCommand(
  pi: ExtensionAPI,
  engine: ADWEngine,
  team: TeamRuntime,
  agentDefs: AgentDefinition[],
  runsDir: string,
): void {
  pi.registerCommand("issue", {
    description:
      "Fetch an issue ticket and chain into the appropriate workflow. Usage: /issue <url-or-id> [--tracker github|ado|jira]",
    handler: async (args, ctx) => {
      const { ticketRef, trackerFlag } = parseIssueArgs(args);

      if (!ticketRef) {
        ctx.ui.notify(
          [
            "Usage: /issue <ticket-url-or-id> [--tracker github|ado|jira]",
            'Example: /issue https://github.com/org/repo/issues/42',
            'Example: /issue PROJ-123',
            'Example: /issue 99 --tracker ado',
          ].join("\n"),
          "error",
        );
        return;
      }

      const resolution = await detectTracker(ticketRef, trackerFlag);

      if (resolution.tracker === "unknown") {
        ctx.ui.notify(
          [
            `Could not detect issue tracker for: ${ticketRef}`,
            "",
            "Specify the tracker using one of these methods:",
            "  1. Pass a full ticket URL (github.com, dev.azure.com, atlassian.net)",
            "  2. Use --tracker flag:  /issue <id> --tracker github|ado|jira",
            "  3. Jira IDs are auto-detected (e.g. PROJ-123)",
            '  4. Create ~/.pi/engineering-team/issue-tracker.json: { "default": "github" }',
            "  5. Ensure a git remote pointing to github.com or dev.azure.com",
          ].join("\n"),
          "error",
        );
        return;
      }

      if (resolution.tracker === "github") {
        const auth = await checkGhAuth();
        if (!auth.ok) {
          const lines: string[] = [];
          if (auth.reason === "missing-binary") {
            lines.push(
              "GitHub CLI (gh) is not installed or not on PATH.",
              "Install: https://cli.github.com — then run `gh auth login`.",
            );
          } else if (auth.reason === "unauthenticated") {
            lines.push(
              "GitHub CLI is installed but not authenticated.",
              "Run: gh auth login",
              "",
              "Details:",
              auth.detail,
            );
          } else {
            lines.push(
              "Could not verify GitHub CLI auth status.",
              `Detail: ${auth.detail}`,
            );
          }
          ctx.ui.notify(lines.join("\n"), "error");
          return;
        }
      }

      for (const def of agentDefs) {
        await team.ensureTeammate(def.name, def);
      }

      const analyzeGoal = `${ticketRef} [tracker:${resolution.tracker}]`;
      const analyzeRun = await engine.startRun({
        workflow: "issue-analyze",
        goal: analyzeGoal,
        budget: {},
      });

      ctx.ui.notify(
        `▶ Fetching ${resolution.tracker} #${resolution.ticketId}…`,
        "info",
      );

      const finalState = await engine.executeRun(analyzeRun.runId);

      if (finalState.status !== "succeeded") {
        const analyzeStep = finalState.steps.find(s => s.name === "analyze");
        const reason = analyzeStep?.issues?.join(", ") ?? analyzeStep?.error ?? "unknown error";
        ctx.ui.notify(`Failed to analyze ticket: ${reason}`, "error");
        return;
      }

      const briefPath = join(runsDir, analyzeRun.runId, "issue-brief.md");
      let briefText: string;
      try {
        briefText = await readFile(briefPath, "utf8");
      } catch {
        ctx.ui.notify("Issue analyst did not write issue-brief.md.", "error");
        return;
      }

      const parsed = parseBrief(briefText);
      if (!parsed) {
        ctx.ui.notify(
          "Could not parse Suggested Workflow or Goal from issue-brief.md. Open the file and check its format.",
          "error",
        );
        return;
      }

      const { suggestedWorkflow, goal } = parsed;
      const goalWithContext = `${goal}\n\n[Issue context available at: ${briefPath}]`;

      ctx.ui.notify(
        `Issue brief ready → ${briefPath}\nChaining into: ${suggestedWorkflow}`,
        "info",
      );

      const downstream = await engine.startRun({
        workflow: suggestedWorkflow,
        goal: goalWithContext,
        budget: {},
        initialArtifacts: [briefPath],
      });

      if (suggestedWorkflow === "spec-plan-build-review") {
        await executeSpecWorkflow(engine, runsDir, downstream.runId, ctx);
      } else {
        void engine.executeRun(downstream.runId);
        ctx.ui.notify(
          [
            `▶ ${suggestedWorkflow} started (run ${downstream.runId.slice(0, 8)})`,
            `Goal: ${goal}`,
            ``,
            `Watch progress:`,
            `  /run-status ${downstream.runId}`,
            `  /observe  (dashboard at http://127.0.0.1:4747)`,
            `  tail -f ~/.pi/engineering-team/runs/${downstream.runId}/events.jsonl`,
          ].join("\n"),
          "info",
        );
      }
    },
  });
}
