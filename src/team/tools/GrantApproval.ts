import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { generateRunSecret, signToken, hashArgs } from "../../safety/approvals.js";

export function createGrantApprovalTool(runsDir: string, runId: string) {
  return defineTool({
    name: "GrantApproval",
    label: "Grant Approval",
    description: "Grant approval for a pending destructive operation. JUDGE ONLY — do not call this unless you are the Judge agent and have reviewed the request against the current plan.",
    parameters: Type.Object({
      requestId: Type.String({ description: "The request ID from RequestApproval" }),
      ttlSeconds: Type.Optional(Type.Number({ description: "Token TTL in seconds (default 300)" })),
      scope: Type.Optional(Type.Union([
        Type.Literal("once"),
        Type.Literal("run-lifetime"),
      ], { description: "once = single use (default), run-lifetime = valid for entire run" })),
    }),
    execute: async (_id, params) => {
      const requestPath = join(runsDir, runId, "approvals", "pending", `${params.requestId}.json`);
      const request = JSON.parse(await readFile(requestPath, "utf8"));

      const secretPath = join(runsDir, runId, ".secret");
      let secret: string;
      try {
        secret = (await readFile(secretPath, "utf8")).trim();
      } catch {
        secret = generateRunSecret();
        await mkdir(join(runsDir, runId), { recursive: true });
        await writeFile(secretPath, secret, { mode: 0o600 });
      }

      const tokenId = crypto.randomUUID();
      const argsHash = hashArgs({ op: request.op, command: request.command });
      const ttl = params.ttlSeconds ?? 300;
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      const scope = params.scope ?? "once";
      const signature = signToken(secret, tokenId, request.op, argsHash, expiresAt);

      const token = {
        tokenId,
        runId,
        op: request.op,
        argsHash,
        scope,
        expiresAt,
        signature,
        consumed: false,
        grantedAt: new Date().toISOString(),
        requestId: params.requestId,
      };

      const approvalsDir = join(runsDir, runId, "approvals");
      await mkdir(approvalsDir, { recursive: true });
      await writeFile(join(approvalsDir, `${tokenId}.json`), JSON.stringify(token, null, 2));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ tokenId, expiresAt, scope, message: "Approval granted. The operation may proceed." }),
        }],
        details: {},
      };
    },
  });
}
