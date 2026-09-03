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
import { GhError, ensureRepoFlag, type GhExec, type GhResult } from "./gh.js";
import { sanitizeTicketText } from "./sanitize.js";

const ISSUE_JSON = "number,title,body,labels,assignees,author,updatedAt,url,state";
const HASH_REF = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const URL_REF =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)\/?(?:#.*)?$/i;
const IDK_MARKER = /<!--\s*factory-idk:([^ ]+)\s*-->/;

export interface GitHubAdapterOptions {
  exec: GhExec;
  /** Bound `owner/repo` used by list/search/detect when no TicketRef is in hand. */
  repo?: string;
  label?: string;
  allowedLabelers?: string[];
  ignoreAuthors?: string[];
  detectCacheMs?: number;
}

export function parseGitHubRef(input: string): TicketRef | null {
  const trimmed = input.trim();
  const hash = HASH_REF.exec(trimmed);
  if (hash) return { tracker: "github", id: `${hash[1]}/${hash[2]}#${hash[3]}` };
  const stripped = trimmed.replace(/\.git(?=\/|#|$)/i, "");
  const url = URL_REF.exec(stripped);
  if (url) return { tracker: "github", id: `${url[1]}/${url[2]}#${url[3]}` };
  return null;
}

export function splitGitHubId(id: string): { repo: string; number: number } | null {
  const m = /^([^/]+\/[^#]+)#(\d+)$/.exec(id);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { repo: m[1], number: Number(m[2]) };
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const out: string[] = [];
  for (const item of labels) {
    if (typeof item === "string") out.push(item);
    else if (item !== null && typeof item === "object" && "name" in item && typeof item.name === "string") {
      out.push(item.name);
    }
  }
  return out;
}

function loginOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "login" in value && typeof value.login === "string") {
    return value.login;
  }
  return "";
}

function assigneesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(loginOf).filter((s) => s.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export class GitHubAdapter implements TrackerAdapter {
  readonly id = "github";
  readonly capabilities: Set<TrackerCapability> = new Set(["editComment", "reactions", "linkPR", "nativeQuery"]);
  private readonly exec: GhExec;
  private readonly repo: string | undefined;
  private readonly label: string;
  private readonly allowedLabelers: readonly string[];
  private readonly ignoreAuthors: readonly string[];
  private readonly detectCacheMs: number;
  private readonly posted = new Map<string, CommentId>();
  private detectMemo: { at: number; value: { available: boolean; reason?: string } } | undefined;
  private readonly roles = new Map<string, string>();

  constructor(opts: GitHubAdapterOptions) {
    this.exec = opts.exec;
    this.repo = opts.repo;
    this.label = opts.label ?? DEFAULTS.trackerEntry.label;
    this.allowedLabelers = opts.allowedLabelers ?? [];
    this.ignoreAuthors = opts.ignoreAuthors ?? [];
    this.detectCacheMs = opts.detectCacheMs ?? Number.POSITIVE_INFINITY;
  }

  parseRef(input: string): TicketRef | null {
    return parseGitHubRef(input);
  }

  async detect(): Promise<{ available: boolean; reason?: string }> {
    const now = Date.now();
    if (this.detectMemo !== undefined && now - this.detectMemo.at < this.detectCacheMs) {
      return this.detectMemo.value;
    }
    const result = await this.execRaw(["auth", "status"], this.repo);
    const value =
      result.code === 0
        ? { available: true }
        : {
            available: false,
            reason: result.stderr.trim() || result.stdout.trim() || `gh auth status exited ${result.code}`,
          };
    this.detectMemo = { at: now, value };
    return value;
  }

  async fetch(ref: TicketRef): Promise<Ticket> {
    const parts = this.requireParts(ref);
    const result = await this.gh(["issue", "view", String(parts.number), "--json", ISSUE_JSON], parts.repo);
    return this.ticketFromJson(this.parseJson(result.stdout), parts.repo);
  }

  async list(q: { label: string; state: string; updatedSince?: Date }): Promise<Ticket[]> {
    const repo = this.repo;
    if (repo === undefined) return [];
    const result = await this.gh(
      ["issue", "list", "--label", q.label, "--state", q.state, "--json", ISSUE_JSON],
      repo,
    );
    const rows = this.parseJson(result.stdout);
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => this.ticketFromJson(row, repo));
  }

  async search(q: { titleTokens: string[] }): Promise<TicketSummary[]> {
    const repo = this.repo;
    if (repo === undefined) return [];
    const query = q.titleTokens.filter((t) => t.length > 0).join(" ");
    if (query.length === 0) return [];
    const result = await this.gh(["search", "issues", query, "--json", "number,title,url,state,updatedAt"], repo);
    const rows = this.parseJson(result.stdout);
    if (!Array.isArray(rows)) return [];
    const out: TicketSummary[] = [];
    for (const row of rows) {
      const rec = asRecord(row);
      if (rec === null) continue;
      if (typeof rec.ref === "object" && rec.ref !== null && "id" in rec.ref && typeof rec.title === "string") {
        const id = String((rec.ref as { id: unknown }).id);
        out.push({
          ref: { tracker: "github", id },
          title: rec.title,
          ...(typeof rec.state === "string" ? { state: rec.state } : {}),
          ...(typeof rec.updatedAt === "string" ? { updatedAt: rec.updatedAt } : {}),
          ...(typeof rec.url === "string" ? { url: rec.url } : {}),
        });
        continue;
      }
      const n = rec.number;
      if (typeof n !== "number" || typeof rec.title !== "string") continue;
      out.push({
        ref: { tracker: "github", id: `${repo}#${n}` },
        title: rec.title,
        ...(typeof rec.state === "string" ? { state: rec.state } : {}),
        ...(typeof rec.updatedAt === "string" ? { updatedAt: rec.updatedAt } : {}),
        ...(typeof rec.url === "string" ? { url: rec.url } : {}),
      });
    }
    return out;
  }

  async getComments(ref: TicketRef, since?: Date): Promise<Comment[]> {
    const parts = this.requireParts(ref);
    const result = await this.gh(["api", `repos/${parts.repo}/issues/${parts.number}/comments`], parts.repo);
    const rows = this.parseJson(result.stdout);
    if (!Array.isArray(rows)) return [];
    const sinceMs = since?.getTime();
    const out: Comment[] = [];
    for (const row of rows) {
      const rec = asRecord(row);
      if (rec === null) continue;
      const author = loginOf(rec.user ?? rec.author);
      if (this.dropAuthor(author)) continue;
      const createdAt =
        typeof rec.created_at === "string"
          ? rec.created_at
          : typeof rec.createdAt === "string"
            ? rec.createdAt
            : "";
      if (sinceMs !== undefined && createdAt.length > 0) {
        const t = Date.parse(createdAt);
        if (Number.isFinite(t) && t < sinceMs) continue;
      }
      out.push({
        id: String(rec.id ?? ""),
        author,
        body: typeof rec.body === "string" ? rec.body : "",
        createdAt,
      });
    }
    return out;
  }

  async labelerOf(ref: TicketRef, label: string): Promise<{ login: string; role: string } | null> {
    const parts = this.requireParts(ref);
    const result = await this.gh(["api", `repos/${parts.repo}/issues/${parts.number}/events`], parts.repo);
    const rows = this.parseJson(result.stdout);
    if (!Array.isArray(rows)) return null;
    let login: string | undefined;
    for (const row of rows) {
      const rec = asRecord(row);
      if (rec === null) continue;
      if (rec.event !== "labeled") continue;
      const name = asRecord(rec.label)?.name;
      if (name !== label) continue;
      const actor = loginOf(rec.actor);
      if (actor.length > 0) login = actor;
    }
    if (login === undefined) return null;
    const role = await this.roleName(parts.repo, login);
    return { login, role };
  }

  async isAuthorized(login: string): Promise<boolean> {
    if (this.allowedLabelers.includes(login)) return true;
    if (this.repo === undefined) return false;
    const role = await this.roleName(this.repo, login);
    return role === "write" || role === "maintain" || role === "admin";
  }

  async acknowledge(ref: TicketRef): Promise<void> {
    const parts = this.requireParts(ref);
    await this.gh(
      ["api", `repos/${parts.repo}/issues/${parts.number}/reactions`, "--raw-field", "content=eyes"],
      parts.repo,
    ).catch(() => undefined);
  }

  async comment(ref: TicketRef, body: string, opts: { idempotencyKey: string }): Promise<CommentId | null> {
    const key = `${ref.id}:${opts.idempotencyKey}`;
    const cached = this.posted.get(key);
    if (cached !== undefined) return cached;
    const existing = await this.findIdempotentComment(ref, opts.idempotencyKey);
    if (existing !== null) {
      this.posted.set(key, existing);
      return existing;
    }
    const parts = this.requireParts(ref);
    const marked = `<!-- factory-idk:${opts.idempotencyKey} -->\n${body}`;
    const result = await this.gh(["issue", "comment", String(parts.number), "--body", marked], parts.repo);
    const id = commentIdFromStdout(result.stdout) ?? key;
    this.posted.set(key, id);
    return id;
  }

  async editComment(ref: TicketRef, id: CommentId, body: string): Promise<void> {
    const parts = this.requireParts(ref);
    await this.gh(
      ["api", "-X", "PATCH", `repos/${parts.repo}/issues/comments/${id}`, "--raw-field", `body=${body}`],
      parts.repo,
    );
  }

  async addLabel(ref: TicketRef, label: string): Promise<void> {
    const parts = this.requireParts(ref);
    await this.gh(["issue", "edit", String(parts.number), "--add-label", label], parts.repo);
  }

  async removeLabel(ref: TicketRef, label: string): Promise<void> {
    const parts = this.requireParts(ref);
    await this.gh(["issue", "edit", String(parts.number), "--remove-label", label], parts.repo);
  }

  async transition(_ref: TicketRef, _target: string): Promise<void> {}

  async assign(ref: TicketRef, user: string): Promise<void> {
    const parts = this.requireParts(ref);
    await this.gh(["issue", "edit", String(parts.number), "--add-assignee", user], parts.repo);
  }

  async linkPR(ref: TicketRef, pr: PRRef): Promise<void> {
    const url = pr.url ?? `https://github.com/${pr.repo}/pull/${pr.number}`;
    await this.comment(ref, `Linked PR: ${url}`, { idempotencyKey: `linkpr:${pr.repo}#${pr.number}` });
  }

  async prHint(pr: PRRef): Promise<{ state?: string; mergeCommit?: string }> {
    const result = await this.gh(["pr", "view", String(pr.number), "--json", "state,mergeCommit"], pr.repo);
    const rec = asRecord(this.parseJson(result.stdout));
    if (rec === null) return {};
    const merge = asRecord(rec.mergeCommit);
    return {
      ...(typeof rec.state === "string" ? { state: rec.state } : {}),
      ...(typeof merge?.oid === "string"
        ? { mergeCommit: merge.oid }
        : typeof rec.mergeCommit === "string"
          ? { mergeCommit: rec.mergeCommit }
          : {}),
    };
  }

  private dropAuthor(login: string): boolean {
    if (login.endsWith("[bot]")) return true;
    return this.ignoreAuthors.some((a) => a.toLowerCase() === login.toLowerCase());
  }

  private async findIdempotentComment(ref: TicketRef, idempotencyKey: string): Promise<CommentId | null> {
    try {
      const comments = await this.getComments(ref);
      const marker = `<!-- factory-idk:${idempotencyKey} -->`;
      const hit = comments.find((c) => c.body.includes(marker) || IDK_MARKER.exec(c.body)?.[1] === idempotencyKey);
      return hit === undefined ? null : hit.id;
    } catch {
      return null;
    }
  }

  private async roleName(repo: string, login: string): Promise<string> {
    const cacheKey = `${repo}:${login}`;
    const cached = this.roles.get(cacheKey);
    if (cached !== undefined) return cached;
    try {
      const result = await this.gh(["api", `repos/${repo}/collaborators/${login}/permission`], repo);
      const rec = asRecord(this.parseJson(result.stdout));
      const role = typeof rec?.role_name === "string" ? rec.role_name : "";
      this.roles.set(cacheKey, role);
      return role;
    } catch {
      this.roles.set(cacheKey, "");
      return "";
    }
  }

  private ticketFromJson(raw: unknown, repo: string): Ticket {
    const rec = asRecord(raw) ?? {};
    const number = typeof rec.number === "number" ? rec.number : Number(rec.number);
    const rawBody = typeof rec.body === "string" ? rec.body : "";
    const labels = labelNames(rec.labels);
    const ticket: Ticket = {
      ref: { tracker: "github", id: `${repo}#${number}` },
      title: typeof rec.title === "string" ? rec.title : "",
      body: sanitizeTicketText(rawBody),
      labels,
      author: loginOf(rec.author),
      raw,
    };
    if (typeof rec.url === "string") ticket.url = rec.url;
    if (typeof rec.state === "string") ticket.state = rec.state.toLowerCase();
    const assignees = assigneesOf(rec.assignees);
    if (assignees.length > 0) ticket.assignees = assignees;
    if (typeof rec.updatedAt === "string") ticket.updatedAt = rec.updatedAt;
    const kindLabel = labels.find((l) => l.startsWith("factory:kind="));
    if (kindLabel !== undefined) {
      const kind = kindLabel.slice("factory:kind=".length);
      if (isTicketKind(kind)) ticket.kind = kind;
    }
    return ticket;
  }

  private requireParts(ref: TicketRef): { repo: string; number: number } {
    if (ref.tracker !== "github") throw new Error(`github adapter: not a github ref: ${ref.tracker}:${ref.id}`);
    const parts = splitGitHubId(ref.id);
    if (parts === null) throw new Error(`github adapter: malformed id: ${ref.id}`);
    return parts;
  }

  private parseJson(text: string): unknown {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    return JSON.parse(trimmed) as unknown;
  }

  private async gh(args: string[], repo: string): Promise<GhResult> {
    const result = await this.execRaw(args, repo);
    if (result.code !== 0) {
      throw new GhError(`gh ${args.join(" ")} exited ${result.code}`, result.code, result.stderr);
    }
    return result;
  }

  private async execRaw(args: string[], repo?: string): Promise<GhResult> {
    const argv = repo !== undefined ? ensureRepoFlag(args, repo) : [...args];
    return this.exec(argv, repo !== undefined ? { repo } : undefined);
  }
}

function commentIdFromStdout(stdout: string): CommentId | undefined {
  const m = /#issuecomment-(\d+)/.exec(stdout);
  return m?.[1];
}
