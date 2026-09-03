// src/v3/transcript-audit.ts — host-only pattern scan of implementer events for test gaming
// (spec §10.3 v3). Deterministic, no model, no network. Never imported from src/codify/: the
// codify miner must not read transcripts (spec §8.4).
import { matchGlob, normalizeRelPath } from "../gate/glob.js";
import { SKIP_MARKER_PATTERNS } from "../gate/manifest.js";
import { v3Enabled, type V3HostConfig } from "./dispatch.js";

export type AuditRule = "undeclared-test-infra" | "skip-marker" | "src-mock" | "src-testid";

export interface AuditFinding {
  rule: AuditRule;
  evidence: string;
  path?: string;
}

/** Structural view of one `events.jsonl` line. Unknown keys are ignored. */
export interface AuditEvent {
  category?: string;
  type?: string;
  agent?: string;
  data?: { tool?: string; args?: { path?: string; content?: string } };
}

export interface AuditInput {
  events: AuditEvent[];
  /** Paths the implementer wrote this run; also attributes events that carry no `agent`. */
  implementerTouched: string[];
  /** Test paths the brief declared. Anything else in test scope is undeclared. */
  testChanges?: string[];
}

export interface TranscriptAuditResult {
  findings: AuditFinding[];
  escalate: boolean;
  code?: "test-tampering";
}

const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "multi_edit",
  "create",
  "str_replace",
  "str_replace_editor",
  "apply_patch",
]);

const TEST_INFRA_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)conftest\.py$/,
  /(?:^|\/)pytest\.ini$/,
  /(?:^|\/)tox\.ini$/,
  /(?:^|\/)setup\.cfg$/,
  /(?:^|\/)\.mocharc\.[^/]+$/,
  /(?:^|\/)(?:vitest|jest|playwright|cypress|karma)\.(?:config|workspace|conf)\.[^/]+$/,
];

const TEST_FILE_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)tests?\//,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /(?:^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
];

/** Mock/monkeypatch of a production module from inside a test file. */
const SRC_MOCK_PATTERNS: readonly RegExp[] = [
  /\b(?:vi|jest)\.(?:mock|doMock|spyOn)\s*\(\s*["'`][^"'`]*\bsrc[./][^"'`]*["'`]/,
  /\bmonkeypatch\.(?:setattr|setitem|delattr)\s*\(\s*["'`][^"'`]*\bsrc[./][^"'`]*["'`]/,
  /\b(?:mock\.)?patch(?:\.object)?\s*\(\s*["'`][^"'`]*\bsrc[./][^"'`]*["'`]/,
];

/** Production code branching on the identity of the test that is running. */
const SRC_TESTID_PATTERNS: readonly RegExp[] = [
  /\bPYTEST_CURRENT_TEST\b/,
  /\b(?:JEST|VITEST)_WORKER_ID\b/,
  /\bexpect\.getState\s*\(/,
  /["'`](?:test|spec|it)[_-][A-Za-z0-9_-]+["'`]/,
];

const EVIDENCE_MAX = 80;

interface WriteAction {
  path: string;
  content: string;
}

/** First match across `patterns`, with any `g` flag dropped so `exec` stays stateless. */
function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = new RegExp(pattern.source, pattern.flags.replace(/g/g, "")).exec(text);
    if (match !== null) return match[0];
  }
  return null;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EVIDENCE_MAX ? `${flat.slice(0, EVIDENCE_MAX)}…` : flat;
}

function isTestInfra(path: string): boolean {
  return TEST_INFRA_PATTERNS.some((re) => re.test(path));
}

function isTestScope(path: string): boolean {
  return isTestInfra(path) || TEST_FILE_PATTERNS.some((re) => re.test(path));
}

function isProductionSrc(path: string): boolean {
  return /(?:^|\/)src\//.test(path);
}

function isDeclared(path: string, declared: readonly string[]): boolean {
  return declared.some((d) => d === path || matchGlob(path, d));
}

/** The write this event performed, or null when it is not an implementer write. */
function implementerWrite(event: AuditEvent, touched: ReadonlySet<string>): WriteAction | null {
  if (event.category !== "tool_call") return null;
  const data = event.data;
  if (data === undefined) return null;
  if (!WRITE_TOOLS.has((data.tool ?? "").toLowerCase())) return null;
  const raw = data.args?.path;
  if (typeof raw !== "string" || raw === "") return null;
  const path = normalizeRelPath(raw);
  if (event.agent === undefined ? !touched.has(path) : event.agent !== "implementer") return null;
  return { path, content: data.args?.content ?? "" };
}

/**
 * Scan implementer writes for the four gaming patterns: undeclared test-infra writes,
 * new skip/xfail/`.only` markers, mocking production code from a test file, and test-id
 * strings hardcoded in `src/`. Findings are event-ordered and deduplicated by rule+path.
 */
export function auditTranscript(input: AuditInput): AuditFinding[] {
  const touched = new Set(input.implementerTouched.map(normalizeRelPath));
  const declared = (input.testChanges ?? []).map(normalizeRelPath);
  const findings: AuditFinding[] = [];
  const seen = new Set<string>();
  const push = (rule: AuditRule, path: string, evidence: string): void => {
    const key = `${rule}\0${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, path, evidence });
  };

  for (const event of input.events) {
    const write = implementerWrite(event, touched);
    if (write === null) continue;
    const { path, content } = write;

    if (isTestInfra(path) && !isDeclared(path, declared)) {
      push("undeclared-test-infra", path, `implementer wrote test infra ${path} outside declared testChanges`);
    }
    if (isTestScope(path)) {
      const marker = firstMatch(content, SKIP_MARKER_PATTERNS);
      if (marker !== null) push("skip-marker", path, `${path} adds skip/only marker: ${snippet(marker)}`);
      const mock = firstMatch(content, SRC_MOCK_PATTERNS);
      if (mock !== null) push("src-mock", path, `${path} mocks production code: ${snippet(mock)}`);
      continue;
    }
    if (isProductionSrc(path)) {
      const testId = firstMatch(content, SRC_TESTID_PATTERNS);
      if (testId !== null) push("src-testid", path, `${path} hardcodes a test id: ${snippet(testId)}`);
    }
  }
  return findings;
}

/** True only when the flag is on and the scan found something. Flag off ⇒ never escalate. */
export function shouldEscalateAudit(cfg: V3HostConfig, findings: readonly AuditFinding[]): boolean {
  if (!v3Enabled(cfg, "transcriptAudit")) return false;
  return findings.length > 0;
}

/**
 * Host wrapper. The scan always runs (it is deterministic and side-effect free); only the
 * escalation is gated, so a flag-off host still gets findings for evidence. Escalating
 * `test-tampering` is terminal — the caller must not retry (spec R2).
 */
export function hostTranscriptAudit(cfg: V3HostConfig, input: AuditInput): TranscriptAuditResult {
  const findings = auditTranscript(input);
  if (!shouldEscalateAudit(cfg, findings)) return { findings, escalate: false };
  return { findings, escalate: true, code: "test-tampering" };
}
