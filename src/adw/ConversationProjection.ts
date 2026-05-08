import { appendFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import type { EngteamEvent } from "../types.js";

// Phase 4.5 M-2: conversation.jsonl entries follow the spec §9.1 shape.
// {ts, from, to, kind, text, ref?} — narrow, agent-readable, capped text.
export type ConversationKind =
  | "request"
  | "dispatch"
  | "position"
  | "adversarial"
  | "synthesis"
  | "correction"
  | "verdict"
  | "note";

export type ConversationEntry = {
  ts: string;
  from: string;
  to: string;
  kind: ConversationKind;
  text: string;
  ref?: string;
};

const KIND_TYPED = new Set<ConversationKind>([
  "request",
  "dispatch",
  "position",
  "adversarial",
  "synthesis",
  "correction",
  "verdict",
  "note",
]);

const TEXT_MAX = 500;

function clip(s: string | undefined, n: number = TEXT_MAX): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function pickStr(p: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = p?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pickStrArr(p: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const v = p?.[key];
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

// Reserved sender labels — only host-generated events may claim these.
// A subprocess-supplied payload.from of these values is rejected, which
// closes the impersonation hole where a worker could write a "user"
// or "system" entry that future agents would render as authoritative.
const RESERVED_SENDERS = new Set(["user", "system", "host", "verifier"]);

function safeFrom(payload: Record<string, unknown> | undefined, trustedAgent: string | undefined, hostFlag?: boolean): string {
  const trusted = trustedAgent && trustedAgent.length > 0 ? trustedAgent : undefined;
  const claimed = pickStr(payload, "from");
  // Host-flagged events: caller asserts trust. Prefer the explicit payload
  // claim (so the host can write "user" / "system" / "verifier" entries),
  // fall back to the trusted agent name, then "system".
  if (hostFlag) return claimed ?? trusted ?? "system";
  // Untrusted events: a subprocess-claimed reserved sender is rejected.
  // Prefer the trusted host-derived agent name; only honor a worker-supplied
  // name when no trusted source exists (and the claim isn't reserved).
  if (claimed && RESERVED_SENDERS.has(claimed)) return trusted ?? "agent";
  return trusted ?? claimed ?? "agent";
}

// Step-name → kind mapping for verdict events. The spec has distinct kinds
// for position / adversarial / synthesis; round-1 H1 closes a regression
// where every VerdictEmit projected as kind=verdict, hiding the dialogue
// structure consult relies on.
function kindFromStep(step: string | undefined, fallback: ConversationKind): ConversationKind {
  if (!step) return fallback;
  if (step.startsWith("position-") || step === "position") return "position";
  if (step.startsWith("adversarial-") || step === "adversarial") return "adversarial";
  if (step === "synthesis" || step.startsWith("synthesis-")) return "synthesis";
  if (step === "dispatch") return "dispatch";
  return fallback;
}

// Map a raw EngteamEvent to a spec-shape ConversationEntry, or undefined to
// skip (most lifecycle/tool events are skipped — only user-visible dialogue
// is projected).
function eventToEntry(evt: EngteamEvent): ConversationEntry | undefined {
  const hostFlag = (evt.payload as Record<string, unknown>)?.["__host"] === true;

  // Direct kind-typed events (anything emitted with type matching a kind).
  // The host emits these for trusted notes; workers normally don't.
  if (KIND_TYPED.has(evt.type as ConversationKind)) {
    const from = safeFrom(evt.payload, evt.agentName, hostFlag);
    // 'to' can be a reserved label only for host-generated events. Worker
    // claims that target "user" are downgraded to "*" so a worker can't
    // forge a private response to the operator.
    const claimedTo = pickStr(evt.payload, "to");
    const to = hostFlag
      ? claimedTo ?? "*"
      : (claimedTo && RESERVED_SENDERS.has(claimedTo) ? "*" : claimedTo ?? "*");
    const text = clip(pickStr(evt.payload, "text") ?? evt.summary ?? "");
    if (!text) return undefined;
    return {
      ts: evt.ts,
      from,
      to,
      kind: evt.type as ConversationKind,
      text,
      ref: pickStr(evt.payload, "ref"),
    };
  }

  // Verdict events: category=verdict captures both VerdictEmit (type=emit)
  // and verifier outcomes (type=verify, verify_exhausted).
  if (evt.category === "verdict") {
    const verdict = pickStr(evt.payload, "verdict") ?? "?";
    const stepLabel = evt.step ?? pickStr(evt.payload, "step") ?? "step";
    const issues = pickStrArr(evt.payload, "issues");
    const headline = `${verdict} on ${stepLabel}` + (issues && issues.length > 0 ? ` — ${issues.join("; ")}` : "");
    const ref = pickStrArr(evt.payload, "artifacts")?.[0]
      ?? pickStr(evt.payload, "report");
    const isVerify = evt.type === "verify" || evt.type === "verify_exhausted";
    const kind: ConversationKind = isVerify
      ? "correction"
      : kindFromStep(stepLabel, "verdict");
    // Verdict events are host-emitted (ADWEngine fans out the audit) so
    // we trust evt.agentName for `from`. Verifier outputs default to
    // "verifier" when agentName is absent.
    return {
      ts: evt.ts,
      from: evt.agentName ?? (isVerify ? "verifier" : "agent"),
      to: "*",
      kind,
      text: clip(evt.summary ?? headline),
      ref,
    };
  }

  // Bus messages: distill into kind=dispatch by default. The bus is
  // host-mediated (only the host's MessageBus can emit type=sent), so
  // payload.from is trusted here.
  if (evt.category === "message" && evt.type === "sent") {
    const from = pickStr(evt.payload, "from") ?? evt.agentName ?? "system";
    const to = pickStr(evt.payload, "to") ?? "*";
    // H2: prefer the full message body, capped to TEXT_MAX. If the
    // message exceeds the cap, fall back to summary and hand the full
    // body via ref (path written by the caller).
    const body = pickStr(evt.payload, "message");
    const summary = pickStr(evt.payload, "summary") ?? evt.summary;
    const ref = pickStr(evt.payload, "ref");
    let text: string;
    if (body && body.length <= TEXT_MAX) {
      text = body;
    } else if (summary) {
      text = clip(summary);
    } else if (body) {
      text = clip(body);
    } else {
      text = "";
    }
    if (!text) return undefined;
    return { ts: evt.ts, from, to, kind: "dispatch", text, ref };
  }

  // Run-level lifecycle (per spec §9.1: run_started, run_paused_for_user,
  // run_completed). Step-level lifecycle is excluded — too noisy for the
  // agent-readable channel.
  if (evt.category === "lifecycle") {
    const isRunLevel =
      evt.type === "run.start" ||
      evt.type === "run.end" ||
      evt.type === "run.cancelled" ||
      evt.type === "run.paused";
    if (!isRunLevel) return undefined;
    return {
      ts: evt.ts,
      from: "system",
      to: "*",
      kind: "note",
      text: clip(evt.summary ?? evt.type),
    };
  }

  return undefined;
}

export function projectionPath(runDir: string): string {
  return join(runDir, "conversation.jsonl");
}

export async function appendProjection(
  runDir: string,
  evt: EngteamEvent,
): Promise<void> {
  const entry = eventToEntry(evt);
  if (!entry) return;
  await mkdir(runDir, { recursive: true });
  await appendFile(projectionPath(runDir), JSON.stringify(entry) + "\n", "utf8");
}

export async function readRecentEntries(
  runDir: string,
  n: number,
): Promise<ConversationEntry[]> {
  let raw: string;
  try {
    raw = await readFile(projectionPath(runDir), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const slice = lines.slice(Math.max(0, lines.length - n));
  const out: ConversationEntry[] = [];
  for (const line of slice) {
    try {
      const parsed = JSON.parse(line) as ConversationEntry;
      // Defensive: skip lines whose shape predates the schema realignment
      // so an old projection file from prior runs doesn't crash a new agent.
      if (
        typeof parsed.ts === "string" &&
        typeof parsed.from === "string" &&
        typeof parsed.to === "string" &&
        typeof parsed.kind === "string" &&
        typeof parsed.text === "string"
      ) {
        out.push(parsed);
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function formatPrelude(entries: ConversationEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => {
    const head = `[${e.kind}] ${e.from} → ${e.to}`;
    const ref = e.ref ? ` (${e.ref})` : "";
    return `- ${head}: ${e.text}${ref}`;
  });
  return ["## Recent conversation", ...lines, ""].join("\n");
}
