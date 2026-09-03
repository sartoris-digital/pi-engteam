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

const AB_REF = /^(?:azure-devops:)?AB#(\d+)$/i;
const HASH_REF = /^#(\d+)$/;
const QUAL_REF = /^(?:azure-devops:|ado:)([^/]+)\/([^#]+)#(\d+)$/i;
const ID_REF = /^(?:azure-devops:)?(\d+)$/;

const CLAIM_DROP = new Set(["factory:ready", "factory:needs-triage", "factory:blocked", "factory:closed"]);

export interface AzureDevOpsAdapterOptions {
  org: string;
  project: string;
  allowedAuthors: string[];
  cli: HostCli;
  site?: string;
  transitions?: { claim?: string; merge?: string };
  ignoreAuthors?: string[];
  transitionOnClaim?: boolean;
  transitionOnMerge?: boolean;
  assignOnClaim?: boolean;
  label?: string;
}

export function parseAzureDevOpsRef(input: string, bound = true): TicketRef | null {
  const trimmed = input.trim();
  const qual = QUAL_REF.exec(trimmed);
  if (qual) return { tracker: "azure-devops", id: `${qual[1]}/${qual[2]}#${qual[3]}` };
  const ab = AB_REF.exec(trimmed);
  if (ab?.[1]) return { tracker: "azure-devops", id: ab[1] };
  if (bound) {
    const hash = HASH_REF.exec(trimmed);
    if (hash?.[1]) return { tracker: "azure-devops", id: hash[1] };
    const bare = ID_REF.exec(trimmed);
    if (bare?.[1] && !/^[A-Z][A-Z0-9]+-\d+$/i.test(trimmed)) return { tracker: "azure-devops", id: bare[1] };
  }
  return null;
}

export function workItemId(id: string): number {
  const m = /(\d+)$/.exec(id);
  if (m?.[1] === undefined) throw new Error(`azure-devops adapter: malformed id: ${id}`);
  return Number(m[1]);
}

export function ticketLinkLine(ref: TicketRef): string {
  return `AB#${workItemId(ref.id)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function uniqueNameOf(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (rec === null) return "";
  if (typeof rec.uniqueName === "string") return rec.uniqueName;
  if (typeof rec.mailAddress === "string") return rec.mailAddress;
  if (typeof rec.displayName === "string") return rec.displayName;
  return "";
}

function splitTags(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw
    .split(/[;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function joinTags(tags: readonly string[]): string {
  return [...tags].join("; ");
}

function kindFromType(value: unknown): Ticket["kind"] {
  if (typeof value !== "string") return undefined;
  const t = value.toLowerCase();
  if (t === "bug") return "bug";
  if (t === "user story" || t === "feature" || t === "epic") return "feature";
  if (t === "task") return "chore";
  if (t === "issue" || t === "improvement") return "enhancement";
  return undefined;
}

function authorsMatch(login: string, allowed: string): boolean {
  const a = login.trim().toLowerCase();
  const b = allowed.trim().toLowerCase();
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  return (a.split("@")[0] ?? a) === (b.split("@")[0] ?? b);
}

export class AzureDevOpsAdapter implements TrackerAdapter {
  readonly id = "azure-devops";
  readonly capabilities: Set<TrackerCapability> = new Set(["transition", "linkPR", "nativeQuery", "editComment"]);
  private readonly cli: HostCli;
  private readonly org: string;
  private readonly project: string;
  private readonly orgUrl: string;
  private readonly allowedAuthors: readonly string[];
  private readonly ignoreAuthors: readonly string[];
  private readonly transitionOnClaim: boolean;
  private readonly claimState: string;
  private readonly assignOnClaim: boolean;
  private detectMemo: { at: number; value: { available: boolean; reason?: string } } | undefined;

  constructor(opts: AzureDevOpsAdapterOptions) {
    if (opts.allowedAuthors.length === 0) {
      throw new Error("azure-devops adapter: allowedAuthors must be non-empty");
    }
    this.cli = opts.cli;
    this.org = opts.org;
    this.project = opts.project;
    this.orgUrl = opts.site ?? `https://dev.azure.com/${opts.org}`;
    this.allowedAuthors = opts.allowedAuthors;
    this.ignoreAuthors = opts.ignoreAuthors ?? [];
    this.transitionOnClaim = opts.transitionOnClaim ?? DEFAULTS.trackerEntry.transitionOnClaim["azure-devops"];
    this.claimState = opts.transitions?.claim ?? "Active";
    this.assignOnClaim = opts.assignOnClaim ?? DEFAULTS.trackerEntry.assignOnClaim;
    void opts.transitionOnMerge;
  }

  parseRef(input: string): TicketRef | null {
    return parseAzureDevOpsRef(input, true);
  }

  async detect(): Promise<{ available: boolean; reason?: string }> {
    if (this.detectMemo !== undefined) return this.detectMemo.value;
    const result = await this.cli.exec(["az", "account", "show"]);
    const value =
      result.code === 0
        ? { available: true }
        : {
            available: false,
            reason: result.stderr.trim() || result.stdout.trim() || `az account show exited ${result.code}`,
          };
    if (value.available) {
      await this.cli.exec(["az", "devops", "configure", "--list"]);
    }
    this.detectMemo = { at: Date.now(), value };
    return value;
  }

  async fetch(ref: TicketRef): Promise<Ticket> {
    const id = this.requireId(ref);
    const result = await this.az(["boards", "work-item", "show", "--id", String(id), "--expand", "all", "-o", "json"]);
    return this.ticketFromJson(this.parseJson(result.stdout), id);
  }

  async list(q: { label: string; state: string; updatedSince?: Date }): Promise<Ticket[]> {
    const clauses = [
      `[System.Tags] CONTAINS '${escapeWiql(q.label)}'`,
      `[System.State] NOT IN ('Closed','Removed')`,
    ];
    if (q.updatedSince !== undefined) {
      clauses.push(`[System.ChangedDate] >= '${q.updatedSince.toISOString()}'`);
    }
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(" AND ")}`;
    const result = await this.az(["boards", "query", "--wiql", wiql, "-o", "json"]);
    const ids = workItemIdsFromQuery(this.parseJson(result.stdout));
    const tickets: Ticket[] = [];
    for (const id of ids) {
      tickets.push(await this.fetch({ tracker: "azure-devops", id: String(id) }));
    }
    return tickets;
  }

  async search(q: { titleTokens: string[] }): Promise<TicketSummary[]> {
    const tokens = q.titleTokens.filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const where = tokens.map((t) => `[System.Title] CONTAINS '${escapeWiql(t)}'`).join(" AND ");
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${where}`;
    const result = await this.az(["boards", "query", "--wiql", wiql, "-o", "json"]);
    const ids = workItemIdsFromQuery(this.parseJson(result.stdout));
    const out: TicketSummary[] = [];
    for (const id of ids) {
      const ticket = await this.fetch({ tracker: "azure-devops", id: String(id) });
      out.push({
        ref: ticket.ref,
        title: ticket.title,
        ...(ticket.state === undefined ? {} : { state: ticket.state }),
        ...(ticket.updatedAt === undefined ? {} : { updatedAt: ticket.updatedAt }),
        ...(ticket.url === undefined ? {} : { url: ticket.url }),
      });
    }
    return out;
  }

  async getComments(_ref: TicketRef, _since?: Date): Promise<Comment[]> {
    return [];
  }

  async labelerOf(ref: TicketRef, _label: string): Promise<{ login: string; role: string } | null> {
    try {
      const ticket = await this.fetch(ref);
      if (ticket.author.length === 0) return null;
      return { login: ticket.author, role: "allowlist" };
    } catch {
      return null;
    }
  }

  async isAuthorized(login: string): Promise<boolean> {
    return this.allowedAuthors.some((a) => authorsMatch(login, a));
  }

  async acknowledge(ref: TicketRef): Promise<void> {
    const current = await this.readTags(ref);
    const next = current.filter((t) => !CLAIM_DROP.has(t));
    if (!next.includes("factory:in-progress")) next.push("factory:in-progress");
    await this.writeTags(ref, next);
    if (this.transitionOnClaim) await this.transition(ref, this.claimState);
    void this.assignOnClaim;
  }

  async comment(_ref: TicketRef, _body: string, _opts: { idempotencyKey: string }): Promise<CommentId | null> {
    return null;
  }

  async editComment(_ref: TicketRef, _id: CommentId, _body: string): Promise<void> {}

  async addLabel(ref: TicketRef, label: string): Promise<void> {
    const tags = await this.readTags(ref);
    if (!tags.includes(label)) tags.push(label);
    await this.writeTags(ref, tags);
  }

  async removeLabel(ref: TicketRef, label: string): Promise<void> {
    const tags = await this.readTags(ref);
    await this.writeTags(
      ref,
      tags.filter((t) => t !== label),
    );
  }

  async transition(ref: TicketRef, target: string): Promise<void> {
    const id = this.requireId(ref);
    await this.az(["boards", "work-item", "update", "--id", String(id), "--state", target, "-o", "json"]);
  }

  async assign(ref: TicketRef, user: string): Promise<void> {
    const id = this.requireId(ref);
    await this.az(["boards", "work-item", "update", "--id", String(id), "--assigned-to", user, "-o", "json"]);
  }

  async linkPR(_ref: TicketRef, _pr: PRRef): Promise<void> {}

  private async readTags(ref: TicketRef): Promise<string[]> {
    const ticket = await this.fetch(ref);
    return [...ticket.labels];
  }

  private async writeTags(ref: TicketRef, tags: readonly string[]): Promise<void> {
    const id = this.requireId(ref);
    await this.az([
      "boards",
      "work-item",
      "update",
      "--id",
      String(id),
      "--fields",
      `System.Tags=${joinTags(tags)}`,
      "-o",
      "json",
    ]);
  }

  private ticketFromJson(raw: unknown, id: number): Ticket {
    const rec = asRecord(raw) ?? {};
    const fields = asRecord(rec.fields) ?? rec;
    const title = typeof fields["System.Title"] === "string" ? fields["System.Title"] : "";
    const bodyRaw = typeof fields["System.Description"] === "string" ? fields["System.Description"] : "";
    const labels = splitTags(fields["System.Tags"]);
    const author = uniqueNameOf(fields["System.CreatedBy"]);
    const ticket: Ticket = {
      ref: { tracker: "azure-devops", id: String(typeof rec.id === "number" ? rec.id : id) },
      title,
      body: sanitizeTicketText(bodyRaw),
      labels,
      author,
      raw,
    };
    const html = asRecord(asRecord(rec._links)?.html);
    if (typeof html?.href === "string") ticket.url = html.href;
    else if (typeof rec.url === "string") ticket.url = rec.url;
    if (typeof fields["System.State"] === "string") ticket.state = fields["System.State"];
    if (typeof fields["System.ChangedDate"] === "string") ticket.updatedAt = fields["System.ChangedDate"];
    const kind = kindFromType(fields["System.WorkItemType"]);
    if (kind !== undefined) ticket.kind = kind;
    const kindLabel = labels.find((l) => l.startsWith("factory:kind="));
    if (kindLabel !== undefined) {
      const k = kindLabel.slice("factory:kind=".length);
      if (isTicketKind(k)) ticket.kind = k;
    }
    return ticket;
  }

  private requireId(ref: TicketRef): number {
    if (ref.tracker !== "azure-devops") {
      throw new Error(`azure-devops adapter: not an azure-devops ref: ${ref.tracker}:${ref.id}`);
    }
    return workItemId(ref.id);
  }

  private parseJson(text: string): unknown {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    return JSON.parse(trimmed) as unknown;
  }

  private async az(args: readonly string[]): Promise<HostCliResult> {
    const argv = ["az", ...args];
    if (!argv.includes("--organization") && !argv.includes("--org")) {
      argv.push("--organization", this.orgUrl, "--project", this.project);
    }
    const result = await this.cli.exec(argv);
    if (result.code !== 0) throw new HostCliError(argv, result);
    return result;
  }
}

function escapeWiql(value: string): string {
  return value.replace(/'/g, "''");
}

function workItemIdsFromQuery(raw: unknown): number[] {
  const rec = asRecord(raw);
  const rows = Array.isArray(raw) ? raw : Array.isArray(rec?.workItems) ? rec.workItems : [];
  const ids: number[] = [];
  for (const row of rows) {
    if (typeof row === "number") {
      ids.push(row);
      continue;
    }
    const item = asRecord(row);
    const id = item?.id;
    if (typeof id === "number") ids.push(id);
    else if (typeof id === "string" && /^\d+$/.test(id)) ids.push(Number(id));
  }
  return ids;
}
