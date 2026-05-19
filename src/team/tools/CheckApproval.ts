// src/team/tools/CheckApproval.ts
//
// PLAN.md ApprovalWatcher Phase 6 — CheckApproval tool.
//
// New tool for the worker-visible wait path. Strict validation matches
// GrantApproval. PURE READ — no fs writes, no subprocess spawn. The
// agent polls this between RequestApproval and tool_call.
//
// Return states (PLAN.md round-A8 MEDIUM 3):
//   pending           — request file still in pending/ (or .granted but
//                       token write not yet visible).
//   granted           — token file in approvals/<tokenId>.json passes
//                       full HMAC + expiry + runId match.
//   denied            — request is in quarantine/, OR emergencyStop is
//                       set globally.
//   not-found         — no trace of this requestId on disk; usually
//                       means the worker has the wrong UUID or the run
//                       has been GC'd.
//   rollback-handoff  — watcher is disabled or this run is not in the
//                       canary list (PLAN.md round-A7 MEDIUM 5).
//                       Worker should exit NEEDS_MORE and let legacy
//                       ADWEngine dispatch handle the approval.
//
// Granted-state check is the round-A1 HIGH 2 verification: load token
// from `<run>/approvals/*.json`, match by token.requestId === ourId,
// require verifyToken + expiry + runId match. Anything short of FULL
// verification returns `pending` (not `granted`) so a forged or
// tampered token never short-circuits the wait.

import { defineTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { createHmac, timingSafeEqual } from "crypto";
import { loadSafetyConfig } from "../../config.js";
import type { CheckApprovalStatus, ApprovalToken } from "../../types.js";

/**
 * Verify the HMAC signature on a token WITHOUT enforcing expiry. The
 * stock `verifyToken` in safety/approvals.ts rejects expired tokens
 * outright; CheckApproval needs to distinguish "verified-expired" from
 * "not a valid token at all" so the worker gets a clear `denied:
 * expired` response instead of silently hanging on `pending`.
 *
 * Mirrors the signing scheme: HMAC-SHA256 over
 * `${runId}:${tokenId}:${op}:${argsHash}:${expiresAt}`. Timing-safe
 * compare on the hex signature.
 */
function verifyTokenSignatureOnly(secret: string, token: ApprovalToken): boolean {
  if (typeof token.runId !== "string" || token.runId.length === 0) return false;
  if (typeof token.tokenId !== "string" || token.tokenId.length === 0) return false;
  if (typeof token.op !== "string" || token.op.length === 0) return false;
  if (typeof token.argsHash !== "string" || token.argsHash.length === 0) return false;
  if (typeof token.expiresAt !== "string" || token.expiresAt.length === 0) return false;
  if (typeof token.signature !== "string") return false;
  const expected = createHmac("sha256", secret)
    .update(`${token.runId}:${token.tokenId}:${token.op}:${token.argsHash}:${token.expiresAt}`)
    .digest("hex");
  if (token.signature.length !== expected.length) return false;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(token.signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type CheckApprovalResponse = {
  status: CheckApprovalStatus;
  requestId: string;
  reason?: string;
  tokenId?: string;
  expiresAt?: string;
  scope?: string;
};

// Run-level gating + emergency-stop are evaluated inline in execute()
// so safety.json is read exactly once per call (Phase 6 review LOW —
// minimize per-poll syscalls). The unified evaluation enforces the
// correct precedence: emergencyStop FIRST, rollback gate SECOND.

/**
 * Find a token in `<run>/approvals/*.json` matching this requestId
 * and report its verification state:
 *   verified-fresh   — signature ok + not expired + runId match → granted.
 *   verified-expired — signature ok + runId match but past expiresAt.
 *   none             — no matching token, or every match fails verify.
 *
 * PURE READ — no rename, no mutation. Skips `*.consumed`, `*.granted`,
 * and the subdirectories (pending/, meta/, quarantine/).
 */
type TokenLookup =
  | { state: "verified-fresh"; token: ApprovalToken }
  | { state: "verified-expired"; token: ApprovalToken }
  | { state: "none" };

async function lookupTokenForRequest(
  runsDir: string,
  runId: string,
  requestId: string,
): Promise<TokenLookup> {
  const approvalsDir = join(runsDir, runId, "approvals");
  const secretPath = join(runsDir, runId, ".secret");
  let secret: string;
  try {
    secret = (await readFile(secretPath, "utf8")).trim();
  } catch {
    return { state: "none" };
  }
  let entries: string[];
  try {
    entries = await readdir(approvalsDir);
  } catch {
    return { state: "none" };
  }
  let firstExpired: ApprovalToken | null = null;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    if (name.endsWith(".consumed")) continue;
    if (name.endsWith(".granted")) continue;
    const path = join(approvalsDir, name);
    let isFile = true;
    try {
      const st = await stat(path);
      if (!st.isFile()) isFile = false;
    } catch {
      isFile = false;
    }
    if (!isFile) continue;
    let parsed: ApprovalToken;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as ApprovalToken;
    } catch {
      continue;
    }
    if (parsed.runId !== runId) continue;
    if ((parsed as ApprovalToken & { requestId?: string }).requestId !== requestId) continue;
    // Signature-only verify so we can distinguish verified-expired
    // from "not a valid token". The expiry check is done separately
    // below to route into denied:expired vs granted.
    if (!verifyTokenSignatureOnly(secret, parsed)) continue;
    if (typeof parsed.expiresAt !== "string") continue;
    const expiresMs = Date.parse(parsed.expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs > Date.now()) {
      return { state: "verified-fresh", token: parsed };
    }
    if (!firstExpired) firstExpired = parsed;
  }
  if (firstExpired) return { state: "verified-expired", token: firstExpired };
  return { state: "none" };
}

/**
 * Check the three pending state markers for this requestId:
 *   pending/<id>.json           — fresh request
 *   pending/<id>.json.tmp       — still being written (very narrow window)
 *   pending/<id>.json.granted   — Judge renamed but token not yet visible
 */
async function pendingStatus(
  runsDir: string,
  runId: string,
  requestId: string,
): Promise<"pending" | "granted-pending-token" | "not-pending"> {
  const pendingDir = join(runsDir, runId, "approvals", "pending");
  const main = join(pendingDir, `${requestId}.json`);
  const granted = join(pendingDir, `${requestId}.json.granted`);
  const tmp = join(pendingDir, `${requestId}.json.tmp`);
  try {
    await stat(granted);
    return "granted-pending-token";
  } catch {
    /* not granted yet */
  }
  try {
    await stat(main);
    return "pending";
  } catch {
    /* not pending */
  }
  try {
    await stat(tmp);
    return "pending";
  } catch {
    return "not-pending";
  }
}

// Phase 6 review (both rounds MEDIUM): cap the quarantine reason
// length and strip control characters before surfacing to the agent.
// The watcher writes this field from logic over a potentially hostile
// pending payload; an unbounded reason can pollute the worker's
// context window and (in theory) carry control-char escapes.
const QUARANTINE_REASON_MAX_LEN = 200;
function sanitizeQuarantineReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  if (stripped.length === 0) return undefined;
  return stripped.length > QUARANTINE_REASON_MAX_LEN
    ? stripped.slice(0, QUARANTINE_REASON_MAX_LEN) + "…"
    : stripped;
}

async function quarantineStatus(
  runsDir: string,
  runId: string,
  requestId: string,
): Promise<{ quarantined: boolean; reason?: string }> {
  const quarantineDir = join(runsDir, runId, "approvals", "quarantine");
  const target = join(quarantineDir, `${requestId}.json`);
  try {
    const raw = await readFile(target, "utf8");
    const parsed = JSON.parse(raw) as { reason?: unknown };
    return { quarantined: true, reason: sanitizeQuarantineReason(parsed.reason) };
  } catch {
    return { quarantined: false };
  }
}

export function createCheckApprovalTool(runsDir: string, runId: string) {
  return defineTool({
    name: "CheckApproval",
    label: "Check Approval",
    description:
      "Poll the status of a pending approval request. Returns pending|granted|denied|not-found|rollback-handoff. Pure read — no side effects.",
    parameters: Type.Object({
      requestId: Type.String({ description: "UUID v4 from a previous RequestApproval response" }),
    }),
    execute: async (_id, params) => {
      const requestId = params.requestId;
      // Strict shape check — same UUID regex as GrantApproval.
      if (!UUID_RE.test(requestId)) {
        const response: CheckApprovalResponse = {
          status: "not-found",
          requestId,
          reason: "requestId must be UUID v4 shape",
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }], details: {} };
      }

      // Phase 6 review (both rounds HIGH): emergency-stop must take
      // precedence over rollback-handoff. PLAN.md item 184 says
      // emergencyStop "denies all requests unconditionally"; routing to
      // legacy ADWEngine dispatch via rollback-handoff would let the
      // legacy path try to mint a token during the stop. Load safety
      // once and evaluate both checks in the correct order.
      const safety = await loadSafetyConfig();
      const cfg = safety.approvalWatcher;

      // 1) Global emergency-stop FIRST. Deny unconditionally.
      if (cfg?.emergencyStop === true) {
        const response: CheckApprovalResponse = {
          status: "denied",
          requestId,
          reason: "emergency-stop",
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }], details: {} };
      }

      // 2) Rollback-handoff gating: if the watcher is not enabled OR
      // this run is not in the canary list, instruct the worker to exit
      // NEEDS_MORE so legacy ADWEngine dispatch handles the approval.
      const onWatcherPath = cfg?.enabled === true && (cfg.allRuns === true || cfg.canaryRunIds.includes(runId));
      if (!onWatcherPath) {
        const response: CheckApprovalResponse = {
          status: "rollback-handoff",
          requestId,
          reason: "approval-watcher not active for this run; exit NEEDS_MORE for legacy dispatch",
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }], details: {} };
      }

      // 3) Granted? Check approvals/<tokenId>.json files for a token
      // whose requestId matches AND full verification passes.
      const lookup = await lookupTokenForRequest(runsDir, runId, requestId);
      if (lookup.state === "verified-fresh") {
        const response: CheckApprovalResponse = {
          status: "granted",
          requestId,
          tokenId: lookup.token.tokenId,
          expiresAt: lookup.token.expiresAt,
          scope: lookup.token.scope,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }], details: {} };
      }
      if (lookup.state === "verified-expired") {
        const response: CheckApprovalResponse = {
          status: "denied",
          requestId,
          reason: "expired",
          tokenId: lookup.token.tokenId,
          expiresAt: lookup.token.expiresAt,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }], details: {} };
      }

      // 4) Pending or granted-pending-token? Both report "pending" to
      // the worker — once the token write lands, the next CheckApproval
      // will see it via lookupTokenForRequest.
      const pending = await pendingStatus(runsDir, runId, requestId);
      if (pending === "pending" || pending === "granted-pending-token") {
        const response: CheckApprovalResponse = { status: "pending", requestId };
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }], details: {} };
      }

      // 5) Quarantined? Surface the quarantine reason as denied.
      const q = await quarantineStatus(runsDir, runId, requestId);
      if (q.quarantined) {
        const response: CheckApprovalResponse = {
          status: "denied",
          requestId,
          reason: q.reason ?? "quarantined",
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }], details: {} };
      }

      // 6) No trace anywhere.
      const response: CheckApprovalResponse = {
        status: "not-found",
        requestId,
        reason: "no pending, granted, or quarantined record for this requestId",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(response) }], details: {} };
    },
    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(`${theme.fg("muted", "? check")}  ${args.requestId}`);
      return text;
    },
    renderResult(result, _options, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const raw = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      try {
        const parsed = JSON.parse(raw) as CheckApprovalResponse;
        const color =
          parsed.status === "granted" ? "success" :
          parsed.status === "denied" ? "error" :
          parsed.status === "rollback-handoff" ? "warning" :
          parsed.status === "not-found" ? "error" :
          "muted";
        const extra = parsed.tokenId
          ? `  token=${parsed.tokenId}`
          : parsed.reason
            ? `  reason=${parsed.reason}`
            : "";
        text.setText(`${theme.fg(color, parsed.status)}  ${parsed.requestId}${extra}`);
      } catch {
        text.setText(raw);
      }
      return text;
    },
  });
}
