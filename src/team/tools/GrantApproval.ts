import { defineTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { generateRunSecret, signToken, hashArgs } from "../../safety/approvals.js";
import { loadSafetyConfig } from "../../config.js";

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
      // Codex round-4 HIGH: `allowRunLifetimeScope: false` is documented as
      // a safety kill switch in README but the previous implementation
      // never read it — any judge call with scope:"run-lifetime" got a
      // reusable token regardless. Load the live config and reject the
      // scope when disabled. Also clamp ttlSeconds to the configured cap
      // so the documented `tokenTtlSeconds` ceiling is enforced.
      const safety = await loadSafetyConfig();
      const requestedScope = params.scope ?? "once";
      if (requestedScope === "run-lifetime" && !safety.allowRunLifetimeScope) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "run-lifetime scope is disabled by safety config (allowRunLifetimeScope=false). Use scope: \"once\" or enable the flag in ~/.pi/engineering-team/safety.json.",
            }),
          }],
          details: {},
        };
      }
      const ttlCap = safety.tokenTtlSeconds ?? 300;
      const requestedTtl = params.ttlSeconds ?? ttlCap;
      const ttl = Math.min(requestedTtl, ttlCap);

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
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      const scope = requestedScope;
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
    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const scope = args.scope ?? "once";
      const ttl = args.ttlSeconds ?? 300;
      text.setText(`${theme.fg("success", "✓ grant")}  ${args.requestId}  [${scope} / ${ttl}s]`);
      return text;
    },
    renderResult(result, _options, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const raw = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map(c => c.text)
        .join("");
      try {
        const parsed = JSON.parse(raw) as { tokenId?: string; expiresAt?: string; scope?: string };
        text.setText(
          `${theme.fg("success", "granted")}  token=${parsed.tokenId ?? "?"}  expires=${parsed.expiresAt ?? "?"}  scope=${parsed.scope ?? "?"}`,
        );
      } catch {
        text.setText(raw);
      }
      return text;
    },
  });
}
