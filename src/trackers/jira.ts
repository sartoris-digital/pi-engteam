import { DEFAULTS } from "../config/defaults.js";
import {
  isTicketKind,
  type Comment,
  type CommentId,
  type PRRef,
  type Ticket,
  type TicketRef,
  type TicketSummary,
  type TrackerAdapter,
  type TrackerCapability,
} from "./adapter.js";
import { HostCliError, type HostCli, type HostCliResult } from "./host-cli.js";
import { sanitizeTicketText } from "./sanitize.js";

const KEY_REF = /^(?:jira:)?([A-Z][A-Z0-9]+-\d+)$/i;

export type JiraCommentMode = "cadence" | "all";

export interface JiraAdapterOptions {
  site: string;
  projectKey: string;
  allowedAuthors: string[];
  cli: HostCli;
  transitions?: { claim?: string; merge?: string };
  ignoreAuthors?: string[];
  transitionOnClaim?: boolean;
  transitionOnMerge?: boolean;
  assignOnClaim?: boolean;
  commentMode?: JiraCommentMode;
}

export function parseJiraRef(input: string): TicketRef | null {
  const trimmed = input.trim();
  const m = KEY_REF.exec(trimmed);
  if (!m?.[1]) return null;
  return { tracker: "jira", id: m[1].toUpperCase() };
}

export function ticketLinkLine(ref: TicketRef): string {
  return ref.id.replace(/^jira:/i, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function emailOf(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (rec === null) return "";
  if (typeof rec.emailAddress === "string") return rec.emailAddress;
  if (typeof rec.accountId === "string") return rec.accountId;
  if (typeof rec.displayName === "string") return rec.displayName;
  return "";
}

function kindFromType(value: unknown): Ticket["kind"] {
  if (typeof value !== "string") return undefined;
  const t = value.toLowerCase();
  if (t === "bug") return "bug";
  if (t === "story" || t === "feature" || t === "epic") return "feature";
  if (t === "task") return "chore";
  if (t === "improvement" || t === "enhancement") return "enhancement";
  return undefined;
}

function authorsMatch(login: string, allowed: string): boolean {
  const a = login.trim().toLowerCase();
  const b = allowed.trim().toLowerCase();
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  return (a.split("@")[0] ?? a) === (b.split("@")[0] ?? b);
}

function commentKind(idempotencyKey: string): "claim" | "terminal" | "stage-exit" | "other" {
  const k = idempotencyKey.toLowerCase();
  if (k.includes("claim")) return "claim";
  if (/terminal|publish|land|escalat|abandon|blocked|done/.test(k)) return "terminal";
  if (k.includes("stage")) return "stage-exit";
  return "other";
}

export class JiraAdapter implements TrackerAdapter {
  readonly id = "jira";
  readonly capabilities: Set<TrackerCapability> = new Set(["transition", "linkPR", "nativeQuery"]);
  private readonly cli: HostCli;
  private readonly projectKey: string;
  private readonly allowedAuthors: readonly string[];
  private readonly ignoreAuthors: readonly string[];
  private readonly transitionOnClaim: boolean;
  private readonly claimState: string;
  private readonly commentMode: JiraCommentMode;
  private readonly posted = new Map<string, CommentId>();
  private readonly lastPosted = new Map<string, CommentId>();
  private detectMemo: { at: number; value: { available: boolean; reason?: string } } | undefined;

  constructor(opts: JiraAdapterOptions) {
    if (opts.allowedAuthors.length === 0) {
      throw new Error("jira adapter: allowedAuthors must be non-empty");
    }
    this.cli = opts.cli;
    this.projectKey = opts.projectKey;
    this.allowedAuthors = opts.allowedAuthors;
    this.ignoreAuthors = opts.ignoreAuthors ?? [];
    this.transitionOnClaim = opts.transitionOnClaim ?? DEFAULTS.trackerEntry.transitionOnClaim.jira;
    this.claimState = opts.transitions?.claim ?? "In Progress";
    this.commentMode = opts.commentMode ?? "cadence";
    void opts.site;
    void opts.transitionOnMerge;
    void opts.assignOnClaim;
  }

  parseRef(input: string): TicketRef | null {
    return parseJiraRef(input);
  }

  async detect(): Promise<{ available: boolean; reason?: string }> {
    if (this.detectMemo !== undefined) return this.detectMemo.value;
    const result = await this.cli.exec(["jira", "me"]);
    const value =
      result.code === 0
        ? { available: true }
        : {
            available: false,
            reason: result.stderr.trim() || result.stdout.trim() || `jira me exited ${result.code}`,
          };
    this.detectMemo = { at: Date.now(), value };
    return value;
  }

  async fetch(ref: TicketRef): Promise<Ticket> {
    const key = this.requireKey(ref);
    const result = await this.jira(["issue", "list", "-q", `key = ${key}`, "--raw"]);
    const rows = this.parseList(result.stdout);
    const raw = rows[0];
    if (raw === undefined) throw new Error(`jira adapter: issue not found: ${key}`);
    return this.ticketFromJson(raw);
  }

  async list(q: { label: string; state: string; updatedSince?: Date }): Promise<Ticket[]> {
    const parts = [`labels = "${q.label}"`, "statusCategory != Done"];
    if (q.updatedSince !== undefined) {
      parts.push(`updated >= "${q.updatedSince.toISOString()}"`);
    }
    const result = await this.jira(["issue", "list", "-q", parts.join(" AND "), "--raw"]);
    return this.parseList(result.stdout).map((row) => this.ticketFromJson(row));
  }

  async search(q: { titleTokens: string[] }): Promise<TicketSummary[]> {
    const tokens = q.titleTokens.filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const jql = tokens.map((t) => `summary ~ "${t.replace(/"/g, '\\"')}"`).join(" AND ");
    const result = await this.jira(["issue", "list", "-q", jql, "--raw"]);
    return this.parseList(result.stdout).map((row) => {
      const ticket = this.ticketFromJson(row);
      return {
        ref: ticket.ref,
        title: ticket.title,
        ...(ticket.state === undefined ? {} : { state: ticket.state }),
        ...(ticket.updatedAt === undefined ? {} : { updatedAt: ticket.updatedAt }),
        ...(ticket.url === undefined ? {} : { url: ticket.url }),
      };
    });
  }

  async getComments(_ref: TicketRef, _since?: Date): Promise<Comment[]> {
    return [];
  }

  async labelerOf(ref: TicketRef, label: string): Promise<{ login: string; role: string } | null> {
    try {
      const ticket = await this.fetch(ref);
      const rec = asRecord(ticket.raw);
      const changelog = asRecord(rec?.changelog);
      const histories = Array.isArray(changelog?.histories) ? changelog.histories : [];
      let login: string | undefined;
      for (const row of histories) {
        const hist = asRecord(row);
        if (hist === null) continue;
        const items = Array.isArray(hist.items) ? hist.items : [];
        const hit = items.some((it) => {
          const item = asRecord(it);
          return item?.field === "labels" && String(item.toString ?? "").split(" ").includes(label);
        });
        if (hit) {
          const author = emailOf(hist.author);
          if (author.length > 0) login = author;
        }
      }
      if (login === undefined) return null;
      return { login, role: "allowlist" };
    } catch {
      return null;
    }
  }

  async isAuthorized(login: string): Promise<boolean> {
    return this.allowedAuthors.some((a) => authorsMatch(login, a));
  }

  async acknowledge(ref: TicketRef): Promise<void> {
    const key = this.requireKey(ref);
    await this.jira(["issue", "edit", key, "--remove-label", "factory:ready"]);
    await this.jira(["issue", "edit", key, "--add-label", "factory:in-progress"]);
    if (this.transitionOnClaim) await this.transition(ref, this.claimState);
  }

  async comment(
    ref: TicketRef,
    body: string,
    opts: { idempotencyKey: string; force?: boolean },
  ): Promise<CommentId | null> {
    const cacheKey = `${ref.id}:${opts.idempotencyKey}`;
    const cached = this.posted.get(cacheKey);
    if (cached !== undefined) return cached;
    const kind = commentKind(opts.idempotencyKey);
    const cadenceSkip =
      this.commentMode === "cadence" && opts.force !== true && (kind === "stage-exit" || kind === "other");
    if (cadenceSkip) return this.lastPosted.get(ref.id) ?? null;
    const key = this.requireKey(ref);
    const result = await this.jira(["issue", "comment", "add", key, "--body-file", "-"], { input: body });
    const rec = asRecord(this.parseJson(result.stdout));
    const id = rec?.id !== undefined ? String(rec.id) : cacheKey;
    this.posted.set(cacheKey, id);
    this.lastPosted.set(ref.id, id);
    return id;
  }

  async addLabel(ref: TicketRef, label: string): Promise<void> {
    await this.jira(["issue", "edit", this.requireKey(ref), "--add-label", label]);
  }

  async removeLabel(ref: TicketRef, label: string): Promise<void> {
    await this.jira(["issue", "edit", this.requireKey(ref), "--remove-label", label]);
  }

  async transition(ref: TicketRef, target: string): Promise<void> {
    await this.jira(["issue", "move", this.requireKey(ref), target]);
  }

  async assign(ref: TicketRef, user: string): Promise<void> {
    await this.jira(["issue", "assign", this.requireKey(ref), user]);
  }

  async linkPR(ref: TicketRef, pr: PRRef): Promise<void> {
    const url = pr.url ?? "";
    await this.jira(["issue", "link", "remote", this.requireKey(ref), url, "PR"]);
  }

  private ticketFromJson(raw: unknown): Ticket {
    const rec = asRecord(raw) ?? {};
    const fields = asRecord(rec.fields) ?? rec;
    const key = typeof rec.key === "string" ? rec.key : "";
    const labels = Array.isArray(fields.labels) ? fields.labels.map((l) => String(l)) : [];
    const bodyRaw = typeof fields.description === "string" ? fields.description : "";
    const status = asRecord(fields.status);
    const ticket: Ticket = {
      ref: { tracker: "jira", id: key },
      title: typeof fields.summary === "string" ? fields.summary : "",
      body: sanitizeTicketText(bodyRaw),
      labels,
      author: emailOf(fields.reporter),
      raw,
    };
    if (typeof rec.self === "string") ticket.url = rec.self;
    if (typeof status?.name === "string") ticket.state = status.name;
    if (typeof fields.updated === "string") ticket.updatedAt = fields.updated;
    const kind = kindFromType(asRecord(fields.issuetype)?.name);
    if (kind !== undefined) ticket.kind = kind;
    const kindLabel = labels.find((l) => l.startsWith("factory:kind="));
    if (kindLabel !== undefined) {
      const k = kindLabel.slice("factory:kind=".length);
      if (isTicketKind(k)) ticket.kind = k;
    }
    return ticket;
  }

  private requireKey(ref: TicketRef): string {
    if (ref.tracker !== "jira") throw new Error(`jira adapter: not a jira ref: ${ref.tracker}:${ref.id}`);
    const parsed = parseJiraRef(ref.id) ?? parseJiraRef(`jira:${ref.id}`);
    if (parsed === null) throw new Error(`jira adapter: malformed id: ${ref.id}`);
    return parsed.id;
  }

  private parseList(text: string): unknown[] {
    const parsed = this.parseJson(text);
    if (Array.isArray(parsed)) return parsed;
    const rec = asRecord(parsed);
    if (Array.isArray(rec?.issues)) return rec.issues;
    if (parsed !== null && parsed !== undefined) return [parsed];
    return [];
  }

  private parseJson(text: string): unknown {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    return JSON.parse(trimmed) as unknown;
  }

  private async jira(args: readonly string[], opts?: { input?: string }): Promise<HostCliResult> {
    const argv = ["jira", ...args];
    const result = await this.cli.exec(argv, opts);
    if (result.code !== 0) throw new HostCliError(argv, result);
    return result;
  }
}
