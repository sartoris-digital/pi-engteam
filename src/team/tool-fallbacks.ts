// Phase A item 2: per-tool fallback registry. Each orchestrator
// custom tool declares its on-disk recovery path (or that it has
// none for security reasons), the descriptor that gets rendered
// into the system prompt's compat table, and an `available()`
// predicate that gates whether the fallback is usable for a given
// capability bundle.
//
// Replaces the hardcoded string concat in buildSystemPrompt so that
// when Pi renames `write` to `writeFile`, only one place needs to
// change. Also gives item 7 telemetry a stable per-tool key.

export type FallbackContext = {
  // The current run's runDir, used to resolve file-path placeholders
  // like `${runDir}/tasks.json`.
  runDir: string;
  verdictFilePath?: string;
  // Built-in tools the model actually has access to per the
  // capability bundle's observedTools. The renderer uses this to
  // pick between `write`-based and `edit`-based fallback text, etc.
  builtinTools: ReadonlySet<string>;
};

export type ToolFallbackDescriptor = {
  // Tool name as registered by the orchestrator (e.g. "VerdictEmit").
  toolName: string;
  // True when the tool has no usable file-write/file-read fallback
  // for security reasons. The system prompt's compat table emits
  // a "fail-fast" instruction for these.
  noFallback?: boolean;
  // True when this tool requires a built-in tool from
  // `ctx.builtinTools`. If the requirement is missing, the
  // renderer documents that the workflow will fail.
  requiresBuiltins?: string[];
  // Render the fallback block — markdown — for the system prompt
  // compat table. Returns undefined if not applicable.
  render: (ctx: FallbackContext) => string | undefined;
};

// VerdictEmit — preferred via tool; fallback writes JSON to the
// host-owned verdict file.
export const VERDICT_EMIT_FALLBACK: ToolFallbackDescriptor = {
  toolName: "VerdictEmit",
  requiresBuiltins: ["write"],
  render(ctx) {
    if (!ctx.verdictFilePath) return undefined;
    const usesEdit = ctx.builtinTools.has("edit") && !ctx.builtinTools.has("write");
    return (
      `\n### Provider compatibility — file-write recovery for VerdictEmit\n` +
      `If the VerdictEmit tool is NOT in your tool inventory, ${usesEdit ? "use the built-in `edit` tool" : "use the built-in `write` tool"} to write the verdict JSON to this exact path:\n` +
      `  **${ctx.verdictFilePath}**\n` +
      `JSON shape: { "step", "verdict": "PASS"|"FAIL"|"NEEDS_MORE", "issues": [], "artifacts": [], "handoffHint": "..." }\n` +
      `The orchestrator reads this file regardless of which path you took. One of the two — VerdictEmit tool call OR a write to this file — is required.`
    );
  },
};

// TaskList — fallback to write tasks.json directly.
export const TASKLIST_FALLBACK: ToolFallbackDescriptor = {
  toolName: "TaskList",
  requiresBuiltins: ["write"],
  render(ctx) {
    if (!ctx.runDir) return undefined;
    const tasksPath = `${ctx.runDir}/tasks.json`;
    return (
      `**TaskList / TaskUpdate** (sub-task tracking)\n` +
      `  Recovery: use the built-in \`write\` tool to atomically rewrite **${tasksPath}** as JSON: \`{ "tasks": [{ "id", "title", "status": "pending"|"in_progress"|"done", "notes" }] }\`. Read with \`read\` on the same path.`
    );
  },
};

// CheckApproval — fallback to read approval files directly.
export const CHECK_APPROVAL_FALLBACK: ToolFallbackDescriptor = {
  toolName: "CheckApproval",
  requiresBuiltins: ["read"],
  render(ctx) {
    if (!ctx.runDir) return undefined;
    const approvalsDir = `${ctx.runDir}/approvals`;
    return (
      `**CheckApproval** (poll for granted approval)\n` +
      `  Recovery: use the built-in \`read\` tool to inspect approval files directly.\n` +
      `  - Pending request: **${approvalsDir}/pending/<requestId>.json** exists → status is "pending".\n` +
      `  - Granted marker: **${approvalsDir}/pending/<requestId>.json.granted** exists → Judge approved; the token write is in flight or done.\n` +
      `  - Token: **${approvalsDir}/<tokenId>.json** with matching \`requestId\` field and unexpired \`expiresAt\` → status is "granted".\n` +
      `  - Quarantine: **${approvalsDir}/quarantine/<requestId>.json** → status is "denied" with the reason in that file.\n` +
      `  None of these → "not-found".`
    );
  },
};

// SendMessage — no broker in subprocess mode; documented no-op.
export const SEND_MESSAGE_FALLBACK: ToolFallbackDescriptor = {
  toolName: "SendMessage",
  render() {
    return (
      `**SendMessage** (cross-agent communication)\n` +
      `  Status in subprocess mode: NO-OP regardless of provider. There is no live message bus inside the agent subprocess — every agent runs independently per step. Skip SendMessage in subprocess mode; communicate via VerdictEmit fields (handoffHint, issues) and shared artifacts instead.`
    );
  },
};

// RequestApproval / GrantApproval / UseSecret — no fallback for
// security reasons.
export const REQUEST_APPROVAL_FALLBACK: ToolFallbackDescriptor = {
  toolName: "RequestApproval",
  noFallback: true,
  render() {
    return (
      `**RequestApproval** (request Judge approval for a destructive op)\n` +
      `  NO file-write recovery. The tool enforces per-run admission lock, pending cap, duplicate collapse, ALLOWED_OPS allowlist, atomic temp+rename, and metadata stamping under the watcher contract. Writing the pending file directly bypasses these safeguards (security downgrade). If RequestApproval is not in your tool inventory, emit verdict="FAIL" with reason="RequestApproval-required" and stop.`
    );
  },
};

export const GRANT_APPROVAL_FALLBACK: ToolFallbackDescriptor = {
  toolName: "GrantApproval",
  noFallback: true,
  render() {
    return (
      `**GrantApproval** (Judge mints approval token)\n` +
      `  NO file-write recovery. Token signing requires the per-run secret + HMAC over (runId, tokenId, op, argsHash, expiresAt, pauseEpoch). The model has no path to the secret. If GrantApproval is not in your tool inventory and you are the Judge, emit verdict="FAIL" with reason="GrantApproval-required" and stop.`
    );
  },
};

export const USE_SECRET_FALLBACK: ToolFallbackDescriptor = {
  toolName: "UseSecret",
  noFallback: true,
  render() {
    return (
      `**UseSecret** (retrieve secret material)\n` +
      `  NO file-write recovery. Secrets MUST NOT be written to disk in the run dir. If UseSecret is not in your tool inventory, emit verdict="FAIL" with reason="UseSecret-required" and stop — do not improvise an alternative.`
    );
  },
};

export const TOOL_FALLBACK_REGISTRY: ToolFallbackDescriptor[] = [
  VERDICT_EMIT_FALLBACK,
  TASKLIST_FALLBACK,
  CHECK_APPROVAL_FALLBACK,
  SEND_MESSAGE_FALLBACK,
  REQUEST_APPROVAL_FALLBACK,
  GRANT_APPROVAL_FALLBACK,
  USE_SECRET_FALLBACK,
];

/**
 * Render the full compat-table block for the system prompt.
 * Skips entries whose `render()` returns undefined (e.g. runDir
 * missing).
 */
export function renderCompatTable(ctx: FallbackContext): string {
  const sections: string[] = [];
  for (const desc of TOOL_FALLBACK_REGISTRY) {
    if (desc.toolName === "VerdictEmit") continue; // rendered separately above the table
    const text = desc.render(ctx);
    if (text) sections.push(text);
  }
  if (sections.length === 0) return "";
  return (
    `\n\n### Other custom tools — provider compatibility table\n` +
    `The orchestrator may register additional custom tools. If a tool you want is NOT in your tool inventory and a documented recovery is listed here, use the recovery. Tools marked "NO file-write recovery" REQUIRE a provider that exposes orchestrator-side custom tools — if those are missing, fail-fast with a FAIL verdict citing the missing tool.\n\n` +
    sections.join("\n\n")
  );
}
