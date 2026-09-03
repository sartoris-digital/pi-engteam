import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { generatedMarker } from "../runtime/marker.js";

export const REQUEST_APPROVAL_TOOL_NAME = "RequestApproval";

export const RequestApprovalParams = Type.Object({
  op: Type.String({ minLength: 1, description: "Short operation label, e.g. git-stash or rm-dir" }),
  command: Type.String({ minLength: 1, description: "The exact command that needs approval" }),
  justification: Type.String({ minLength: 1, description: "Why the step cannot finish without it" }),
});
export type RequestApprovalInput = Static<typeof RequestApprovalParams>;

export interface PendingApproval {
  _marker: string;
  requestId: string;
  runId: string;
  stage: string;
  agent: string;
  op: string;
  command: string;
  justification: string;
  requestedAt: string;
}

export interface RequestApprovalOptions {
  runDir: string;
  runId: string;
  stage: string;
  agent: string;
  now?: () => Date;
  newId?: () => string;
}

export function pendingApprovalPath(runDir: string, requestId: string): string {
  return join(runDir, "approvals", "pending", `${requestId}.json`);
}

export function createRequestApprovalTool(opts: RequestApprovalOptions): ToolDefinition<typeof RequestApprovalParams, { requestId: string }> {
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? randomUUID;
  return {
    name: REQUEST_APPROVAL_TOOL_NAME,
    label: "Request approval",
    description:
      'Ask the operator for a once-scope approval of a destructive command. Returns a request id; afterwards call VerdictEmit with verdict "NEEDS_MORE" and flags ["approval-needed"]. The step resumes once the operator grants the request.',
    promptSnippet: "Request operator approval for a destructive command, then VerdictEmit NEEDS_MORE with flags approval-needed",
    parameters: RequestApprovalParams,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const requestId = newId();
      const record: PendingApproval = {
        _marker: generatedMarker(opts.runId),
        requestId,
        runId: opts.runId,
        stage: opts.stage,
        agent: opts.agent,
        op: params.op,
        command: params.command,
        justification: params.justification,
        requestedAt: now().toISOString(),
      };
      const path = pendingApprovalPath(opts.runDir, requestId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      return {
        content: [
          {
            type: "text",
            text: `Approval request ${requestId} recorded for ${params.op}. Now call VerdictEmit with verdict "NEEDS_MORE" and flags ["approval-needed"].`,
          },
        ],
        details: { requestId },
      };
    },
  };
}
