// src/git/prbody.ts — host-owned PR body (spec §6.1, §6.3). Model/ticket text only inside
// neutralized markdown blockquotes; headings, checklists and links are host strings.

export type AcSource = "quoted" | "derived" | "inferred";

/** Structural brief subset used in the PR body. Group 2's Brief is assignable. */
export interface PrBriefAc {
  id: string;
  text: string;
  source: AcSource;
  quote?: string;
}

export interface PrBrief {
  kind?: string;
  confidence?: string;
  tier?: string;
  lane?: string;
  flags?: readonly string[];
  acceptanceCriteria?: readonly PrBriefAc[];
}

const DEFAULT_MAX_BYTES = 8192;
const DENY_LIST = ["atlantis", "/deploy", "/approve", "/lgtm", "/merge", "@dependabot", "terraform"] as const;
const DENY_RE = new RegExp(
  `(?<!\`)(?:${DENY_LIST.map(escapeRegExp).join("|")})(?!\`)`,
  "gi",
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function capBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end -= 1;
  return text.slice(0, end);
}

/** Neutralise bot triggers in untrusted quoted text. Caps at 8 KB. */
export function neutralizeQuoted(text: string, maxBytes = DEFAULT_MAX_BYTES): string {
  const capped = capBytes(text.replace(/\r\n?/g, "\n"), maxBytes);
  const lines = capped.split("\n").map((line) => {
    const leading = line.replace(/^([ \t]*)([/@!][^\s]*)/, (_m, ws: string, tok: string) => `${ws}\`${tok}\``);
    return leading.replace(DENY_RE, (match) => `\`${match}\``);
  });
  return lines.join("\n");
}

function blockquote(text: string): string {
  const n = neutralizeQuoted(text);
  if (n === "") return ">";
  return n
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

export interface ComposePrBodyInput {
  judgeSummary?: string;
  brief?: PrBrief;
  gate?: { redIds: string[]; greenIds: string[] };
  checks?: Array<{ name: string; exitCode: number; outputTail: string }>;
  review?: { verdict: string };
  verifier?: { verdict: string };
  manifest?: { ok: boolean };
  scope?: { ok: boolean; detail?: string };
  lockfileDiff?: string;
  conflicts?: string[];
  humanIntervened?: { turns: number };
  run: { runId: string; wallSeconds: number; iteration: number; costUsd: number };
  ticketLine: string;
  coAuthoredBy?: string;
  rulesApplied?: string[];
}

function section(title: string, body: string): string {
  return `## ${title}\n${body}`;
}

/** Assemble `<runDir>/pr-body.md` from signed evidence (spec §6.3 order). */
export function composePrBody(input: ComposePrBodyInput): string {
  const parts: string[] = [];

  parts.push(section("Judge", input.judgeSummary !== undefined && input.judgeSummary !== "" ? blockquote(input.judgeSummary) : "> _(none)_"));

  const brief = input.brief;
  const classLines = [
    `- kind: ${brief?.kind ?? "unknown"}`,
    `- confidence: ${brief?.confidence ?? "unknown"}`,
    `- tier: ${brief?.tier ?? "unknown"}`,
    `- lane: ${brief?.lane ?? "unknown"}`,
  ];
  if (brief?.flags !== undefined && brief.flags.length > 0) classLines.push(`- flags: ${brief.flags.join(", ")}`);
  parts.push(section("Classification", classLines.join("\n")));

  const ac = brief?.acceptanceCriteria ?? [];
  const acBody =
    ac.length === 0
      ? "_(none recorded)_"
      : ac
          .map((item) => {
            const text = blockquote(item.text);
            const quote = item.quote !== undefined && item.quote !== "" ? `\n${blockquote(item.quote)}` : "";
            return `- [ ] ${item.id} _(${item.source})_\n${text}${quote}`;
          })
          .join("\n");
  parts.push(section("Acceptance criteria", acBody));

  if (input.gate !== undefined) {
    parts.push(
      section(
        "Gate",
        [`- RED: ${input.gate.redIds.join(", ") || "(none)"}`, `- GREEN: ${input.gate.greenIds.join(", ") || "(none)"}`].join("\n"),
      ),
    );
  }

  if (input.checks !== undefined) {
    const lines = input.checks.map((c) => {
      const tail = c.outputTail.trim() === "" ? "" : `\n${blockquote(c.outputTail)}`;
      return `- ${c.name}: exit ${c.exitCode}${tail}`;
    });
    parts.push(section("Checks", lines.join("\n") || "_(none)_"));
  }

  if (input.review !== undefined) parts.push(section("Review", `- verdict: ${input.review.verdict}`));
  if (input.verifier !== undefined) parts.push(section("Verifier", `- verdict: ${input.verifier.verdict}`));
  if (input.manifest !== undefined) parts.push(section("Manifest", `- ok: ${input.manifest.ok ? "true" : "false"}`));
  if (input.scope !== undefined) {
    const detail = input.scope.detail !== undefined && input.scope.detail !== "" ? `\n${blockquote(input.scope.detail)}` : "";
    parts.push(section("Scope", `- ok: ${input.scope.ok ? "true" : "false"}${detail}`));
  }
  if (input.lockfileDiff !== undefined && input.lockfileDiff !== "") {
    parts.push(section("Lockfile", blockquote(input.lockfileDiff)));
  }
  if (input.conflicts !== undefined && input.conflicts.length > 0) {
    parts.push(section("Conflicts", input.conflicts.map((c) => `- ${c}`).join("\n")));
  }
  if (input.humanIntervened !== undefined) {
    parts.push(section("Human intervention", `- turns: ${input.humanIntervened.turns}`));
  }

  const runLines = [
    `- runId: ${input.run.runId}`,
    `- wallSeconds: ${input.run.wallSeconds}`,
    `- iteration: ${input.run.iteration}`,
    `- costUsd: ${input.run.costUsd}`,
  ];
  if (input.rulesApplied !== undefined && input.rulesApplied.length > 0) {
    runLines.push(`- rulesApplied: ${input.rulesApplied.join(", ")}`);
  }
  parts.push(section("Run", runLines.join("\n")));

  parts.push(input.ticketLine);
  if (input.coAuthoredBy !== undefined && input.coAuthoredBy !== "") {
    parts.push(`Co-Authored-By: ${input.coAuthoredBy}`);
  }
  return `${parts.join("\n\n")}\n`;
}
