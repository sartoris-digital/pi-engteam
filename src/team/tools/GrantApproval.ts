import { defineTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "fs/promises";
import { realpathSync } from "fs";
import { join, sep } from "path";
import { generateRunSecret, signToken, hashArgs } from "../../safety/approvals.js";
import { loadSafetyConfig } from "../../config.js";

// Codex round-5 HIGH: requestId flows from a tool parameter straight into a
// path join (`pending/${requestId}.json`). UUID-shaped IDs are the contract
// (RequestApproval mints crypto.randomUUID), but the schema only declared
// `Type.String()`. A malicious or buggy worker could request approval with
// requestId="../../state" and trick GrantApproval into reading state.json.
// Validate the exact UUID v4 shape (8-4-4-4-12 hex) before any path join.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function safeRealResolve(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

// Codex round-5 HIGH: the pending-request file is mutable between
// RequestApproval write and GrantApproval read. Without payload validation
// + containment, a worker could rewrite its own request after the judge
// reviewed it (TOCTOU) so the signed argsHash covers a DIFFERENT command
// than the human approved. Strict validation of the loaded payload limits
// the trust we extend, and containment of the resolved path forces the
// file to live inside approvals/pending.
type PendingRequest = {
  requestId: string;
  runId: string;
  op: string;
  command: string;
  justification: string;
  createdAt: string;
};
const ALLOWED_OPS = new Set(["git-push", "npm-install-new", "migration", "bash", "write", "edit", "verifier-script-update"]);
function validatePendingRequest(raw: unknown, expectedId: string, expectedRunId: string): PendingRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["requestId"] !== "string" || o["requestId"] !== expectedId) return null;
  if (typeof o["runId"] !== "string" || o["runId"] !== expectedRunId) return null;
  if (typeof o["op"] !== "string" || !ALLOWED_OPS.has(o["op"])) return null;
  if (typeof o["command"] !== "string" || o["command"].length === 0 || o["command"].length > 4096) return null;
  if (typeof o["justification"] !== "string" || o["justification"].length > 4096) return null;
  if (typeof o["createdAt"] !== "string") return null;
  return {
    requestId: o["requestId"],
    runId: o["runId"],
    op: o["op"],
    command: o["command"],
    justification: o["justification"],
    createdAt: o["createdAt"],
  };
}

export function createGrantApprovalTool(runsDir: string, runId: string) {
  return defineTool({
    name: "GrantApproval",
    label: "Grant Approval",
    description: "Grant approval for a pending destructive operation. JUDGE ONLY — do not call this unless you are the Judge agent and have reviewed the request against the current plan.",
    parameters: Type.Object({
      requestId: Type.String({ description: "The request ID from RequestApproval (UUID v4)" }),
      ttlSeconds: Type.Optional(Type.Number({ description: "Token TTL in seconds (default = safety.tokenTtlSeconds)" })),
      scope: Type.Optional(Type.Union([
        Type.Literal("once"),
        Type.Literal("run-lifetime"),
      ], { description: "once = single use (default), run-lifetime = valid for entire run (requires safety.allowRunLifetimeScope)" })),
      expectedOp: Type.Optional(Type.String({
        description: "Defense-in-depth: echo back the op you are approving. GrantApproval verifies request.op matches; mismatch = refusal.",
      })),
      expectedCommand: Type.Optional(Type.String({
        description: "Defense-in-depth: echo back the command/path you are approving. GrantApproval verifies request.command matches; mismatch = refusal.",
      })),
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

      // UUID + containment check: only files inside pending/ with a
      // uuid-shaped name are accepted.
      if (!UUID_RE.test(params.requestId)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: `requestId must be UUID v4 shape; got ${JSON.stringify(params.requestId)}.` }),
          }],
          details: {},
        };
      }
      const pendingRoot = safeRealResolve(join(runsDir, runId, "approvals", "pending"));
      const requestPath = join(runsDir, runId, "approvals", "pending", `${params.requestId}.json`);
      const realRequestPath = safeRealResolve(requestPath);
      const sepStr = pendingRoot.endsWith(sep) ? pendingRoot : pendingRoot + sep;
      if (!realRequestPath.startsWith(sepStr) || !realRequestPath.endsWith(".json")) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: `Approval request path is outside the pending dir; refusing.` }),
          }],
          details: {},
        };
      }
      // Atomic rename out of pending/ BEFORE reading. Closes the
      // post-read TOCTOU window: any subsequent write by the worker
      // creates a NEW pending/<id>.json that GrantApproval no longer
      // looks at, while we sign the snapshot of the granted file. Lose
      // the rename → loser sees ENOENT and we refuse the grant.
      const grantedPath = requestPath + ".granted";
      try {
        const { rename } = await import("fs/promises");
        await rename(requestPath, grantedPath);
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: `Approval request not found at pending/${params.requestId}.json (already granted or never requested): ${err instanceof Error ? err.message : String(err)}`,
            }),
          }],
          details: {},
        };
      }
      let rawRequest: unknown;
      try {
        rawRequest = JSON.parse(await readFile(grantedPath, "utf8"));
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: `Approval request file unreadable: ${err instanceof Error ? err.message : String(err)}` }),
          }],
          details: {},
        };
      }
      const request = validatePendingRequest(rawRequest, params.requestId, runId);
      if (!request) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "Approval request payload failed validation (requestId/runId mismatch, unknown op, or command too long).",
            }),
          }],
          details: {},
        };
      }
      // Optional defense-in-depth: if the judge supplied expectedOp /
      // expectedCommand, require them to match the file. This closes the
      // pre-read TOCTOU window because the judge stating what it is
      // approving forces the signed argsHash to match the judge's
      // intent rather than whatever the worker has on disk at read time.
      if (params.expectedOp !== undefined && params.expectedOp !== request.op) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: `expectedOp '${params.expectedOp}' does not match request.op '${request.op}'. Refusing — the pending request may have been tampered with.`,
            }),
          }],
          details: {},
        };
      }
      if (params.expectedCommand !== undefined && params.expectedCommand !== request.command) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: `expectedCommand does not match request.command. Refusing — the pending request may have been tampered with.`,
            }),
          }],
          details: {},
        };
      }

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
      const signature = signToken(secret, tokenId, request.op, argsHash, expiresAt, runId);

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
