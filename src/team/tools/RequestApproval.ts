import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

export function createRequestApprovalTool(runsDir: string, runId: string) {
  return defineTool({
    name: "RequestApproval",
    label: "Request Approval",
    description: "Request approval from the Judge before executing a destructive operation. Wait for GrantApproval before proceeding.",
    parameters: Type.Object({
      op: Type.String({ description: "Operation type: 'git-push'|'npm-install-new'|'migration'|'bash'|'write'|'edit'" }),
      command: Type.String({ description: "The exact command or file path that requires approval" }),
      justification: Type.String({ description: "Why this operation is necessary for the current task" }),
    }),
    execute: async (_id, params) => {
      const requestId = crypto.randomUUID();
      const pendingDir = join(runsDir, runId, "approvals", "pending");
      await mkdir(pendingDir, { recursive: true });
      const request = {
        requestId,
        runId,
        op: params.op,
        command: params.command,
        justification: params.justification,
        createdAt: new Date().toISOString(),
      };
      await writeFile(
        join(pendingDir, `${requestId}.json`),
        JSON.stringify(request, null, 2),
      );
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ requestId, message: "Approval request submitted. The Judge will review and grant or deny." }),
        }],
        details: {},
      };
    },
  });
}
