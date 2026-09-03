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

const ISSUE_REF = /^gitlab#(\d+)$/i;
const PATH_REF = /^(?:gitlab:)?([A-Za-z0-9_.][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)+)#(\d+)$/;
const URL_REF = /^https?:\/\/[^/]+\/([A-Za-z0-9_.\-/]+)\/-\/issues\/(\d+)\/?(?:[#?].*)?$/i;
const MR_URL_REF = /^https?:\/\/[^/]+\/([A-Za-z0-9_.\-/]+)\/-\/merge_requests\/(\d+)/i;
const IDK_MARKER = /<!--\s*factory-idk:([^ ]+)\s*-->/;
const NOTE_URL = /#note_(\d+)/;

/** GitLab Developer (30) is the lowest role allowed to drive the factory. */
const MIN_ACCESS_LEVEL = 30;
/** GitLab exposes membership, not GitHub-style role names. */
const MEMBER_ROLE = "member";

export interface GitLabAdapterOptions {
  /** Must be true: the adapter is gated behind `operator.v3.gitlab.enabled`. */
  enabled: boolean;
  cli: HostCli;
  /** Bound `group/project` path used by list/search and by unqualified refs. */
  project: string;
  allowedLabelers?: string[];
}

export function parseGitLabRef(input: string, defaultProject?: string): TicketRef | null {
  const trimmed = input.trim();
  const short = ISSUE_REF.exec(trimmed);
  if (short?.[1] !== undefined) {
    if (defaultProject === undefined || defaultProject.length === 0) return null;
    return { tracker: "gitlab", id: `${defaultProject}#${short[1]}` };
  }
  const path = PATH_REF.exec(trimmed);
  if (path?.[1] !== undefined && path[2] !== undefined) {
    return { tracker: "gitlab", id: `${path[1]}#${path[2]}` };
  }
  const url = URL_REF.exec(trimmed);
  if (url?.[1] !== undefined && url[2] !== undefined) {
    return { tracker: "gitlab", id: `${url[1]}#${url[2]}` };
  }
  return null;
}

function splitGitLabId(id: string): { project: string; iid: number } | null {
  const m = /^(.+)#(\d+)$/.exec(id);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  return { project: m[1], iid: Number(m[2]) };
}

function encodeProject(project: string): string {
  return encodeURIComponent(project);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const out: string[] = [];
  for (const item of labels) {
    if (typeof item === "string") out.push(item);
    else {
      const name = asRecord(item)?.name;
      if (typeof name === "string") out.push(name);
    }
  }
  return out;
}

function usernameOf(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (rec === null) return "";
  if (typeof rec.username === "string") return rec.username;
  if (typeof rec.name === "string") return rec.name;
  return "";
}

function assigneesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(usernameOf).filter((s) => s.length > 0);
}

/** GitLab issue states are `opened` / `closed`; callers speak the generic `open`. */
function gitlabState(state: string): string {
  const s = state.trim().toLowerCase();
  if (s === "open" || s === "opened") return "opened";
  if (s === "close" || s === "closed") return "closed";
  return s;
}

function noteIdFrom(stdout: string): CommentId | undefined {
  const trimmed = stdout.trim();
  const url = NOTE_URL.exec(trimmed);
  if (url?.[1] !== undefined) return url[1];
  try {
    const rec = asRecord(JSON.parse(trimmed) as unknown);
    return rec?.id === undefined ? undefined : String(rec.id);
  } catch {
    return undefined;
  }
}

export class GitLabAdapter implements TrackerAdapter {
  readonly id = "gitlab";
  readonly capabilities: Set<TrackerCapability> = new Set(["transition", "linkPR", "nativeQuery"]);
  private readonly cli: HostCli;
  private readonly project: string;
  private readonly allowedLabelers: readonly string[];
  private readonly posted = new Map<string, CommentId>();
  private detectMemo: { available: boolean; reason?: string } | undefined;

  constructor(opts: GitLabAdapterOptions) {
    if (opts.enabled !== true) {
      throw new Error("gitlab adapter: disabled; set operator.v3.gitlab.enabled = true");
    }
    this.cli = opts.cli;
    this.project = opts.project;
    this.allowedLabelers = opts.allowedLabelers ?? [];
  }

  parseRef(input: string): TicketRef | null {
    return parseGitLabRef(input, this.project);
  }

  async detect(): Promise<{ available: boolean; reason?: string }> {
    if (this.detectMemo !== undefined) return this.detectMemo;
    const result = await this.cli.exec(["glab", "auth", "status"]);
    const value =
      result.code === 0
        ? { available: true }
        : {
            available: false,
            reason: result.stderr.trim() || result.stdout.trim() || `glab auth status exited ${result.code}`,
          };
    this.detectMemo = value;
    return value;
  }

  async fetch(ref: TicketRef): Promise<Ticket> {
    const parts = this.requireParts(ref);
    const result = await this.glab(["issue", "view", String(parts.iid), "--output", "json"], parts.project);
    return this.ticketFromJson(this.parseJson(result.stdout), parts.project);
  }

  async list(q: { label: string; state: string; updatedSince?: Date }): Promise<Ticket[]> {
    const args = ["issue", "list", "--label", q.label, "--state", gitlabState(q.state), "--output", "json"];
    if (q.updatedSince !== undefined) args.push("--updated-after", q.updatedSince.toISOString());
    const result = await this.glab(args, this.project);
    const rows = this.parseJson(result.stdout);
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => this.ticketFromJson(row, this.project));
  }

  async search(q: { titleTokens: string[] }): Promise<TicketSummary[]> {
    const query = q.titleTokens.filter((t) => t.length > 0).join(" ");
    if (query.length === 0) return [];
    const result = await this.glab(["issue", "list", "--search", query, "--output", "json"], this.project);
    const rows = this.parseJson(result.stdout);
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const ticket = this.ticketFromJson(row, this.project);
      return {
        ref: ticket.ref,
        title: ticket.title,
        ...(ticket.state === undefined ? {} : { state: ticket.state }),
        ...(ticket.updatedAt === undefined ? {} : { updatedAt: ticket.updatedAt }),
        ...(ticket.url === undefined ? {} : { url: ticket.url }),
      };
    });
  }

  async getComments(ref: TicketRef, since?: Date): Promise<Comment[]> {
    const parts = this.requireParts(ref);
    const result = await this.glab(["api", `projects/${encodeProject(parts.project)}/issues/${parts.iid}/notes`]);
    const rows = this.parseJson(result.stdout);
    if (!Array.isArray(rows)) return [];
    const sinceMs = since?.getTime();
    const out: Comment[] = [];
    for (const row of rows) {
      const rec = asRecord(row);
      if (rec === null) continue;
      const author = usernameOf(rec.author);
      if (author.endsWith("[bot]")) continue;
      const createdAt = typeof rec.created_at === "string" ? rec.created_at : "";
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
    try {
      const result = await this.glab([
        "api",
        `projects/${encodeProject(parts.project)}/issues/${parts.iid}/resource_label_events`,
      ]);
      const rows = this.parseJson(result.stdout);
      if (!Array.isArray(rows)) return null;
      let login: string | undefined;
      for (const row of rows) {
        const rec = asRecord(row);
        if (rec === null || rec.action !== "add") continue;
        if (asRecord(rec.label)?.name !== label) continue;
        const actor = usernameOf(rec.user);
        if (actor.length > 0) login = actor;
      }
      return login === undefined ? null : { login, role: MEMBER_ROLE };
    } catch {
      return null;
    }
  }

  async isAuthorized(login: string): Promise<boolean> {
    if (this.allowedLabelers.includes(login)) return true;
    try {
      const result = await this.glab([
        "api",
        `projects/${encodeProject(this.project)}/members/all?query=${encodeURIComponent(login)}`,
      ]);
      const rows = this.parseJson(result.stdout);
      if (!Array.isArray(rows)) return false;
      for (const row of rows) {
        const rec = asRecord(row);
        if (rec === null) continue;
        if (usernameOf(rec).toLowerCase() !== login.toLowerCase()) continue;
        const level = Number(rec.access_level);
        if (Number.isFinite(level) && level >= MIN_ACCESS_LEVEL) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async acknowledge(ref: TicketRef): Promise<void> {
    const parts = this.requireParts(ref);
    await this.glab([
      "api",
      "-X",
      "POST",
      `projects/${encodeProject(parts.project)}/issues/${parts.iid}/award_emoji?name=eyes`,
    ]).catch(() => undefined);
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
    const result = await this.glab(["issue", "note", String(parts.iid), "--message", marked], parts.project);
    const id = noteIdFrom(result.stdout) ?? key;
    this.posted.set(key, id);
    return id;
  }

  async addLabel(ref: TicketRef, label: string): Promise<void> {
    const parts = this.requireParts(ref);
    await this.glab(["issue", "update", String(parts.iid), "--label", label], parts.project);
  }

  async removeLabel(ref: TicketRef, label: string): Promise<void> {
    const parts = this.requireParts(ref);
    await this.glab(["issue", "update", String(parts.iid), "--unlabel", label], parts.project);
  }

  async transition(ref: TicketRef, target: string): Promise<void> {
    const parts = this.requireParts(ref);
    const state = gitlabState(target);
    const verb = state === "closed" ? "close" : state === "opened" ? "reopen" : undefined;
    if (verb === undefined) return;
    await this.glab(["issue", verb, String(parts.iid)], parts.project);
  }

  async assign(ref: TicketRef, user: string): Promise<void> {
    const parts = this.requireParts(ref);
    await this.glab(["issue", "update", String(parts.iid), "--assignee", user], parts.project);
  }

  async linkPR(ref: TicketRef, pr: PRRef): Promise<void> {
    const parts = this.requireParts(ref);
    const project = pr.repo.length > 0 ? pr.repo : parts.project;
    await this.glab(["mr", "update", String(pr.number), "--related-issue", String(parts.iid)], project);
  }

  async prHint(pr: PRRef): Promise<{ state?: string; mergeCommit?: string }> {
    const project = pr.repo.length > 0 ? pr.repo : this.project;
    const result = await this.glab(["mr", "view", String(pr.number), "--output", "json"], project);
    const rec = asRecord(this.parseJson(result.stdout));
    if (rec === null) return {};
    return {
      ...(typeof rec.state === "string" ? { state: rec.state } : {}),
      ...(typeof rec.merge_commit_sha === "string" ? { mergeCommit: rec.merge_commit_sha } : {}),
    };
  }

  /** Enables GitLab auto-merge (merge when the pipeline succeeds); never a bare `mr merge`. */
  async enqueueMergeQueue(pr: { url: string; number?: number }): Promise<{ queued: boolean; detail: string }> {
    const parsed = MR_URL_REF.exec(pr.url.trim());
    const iid = pr.number ?? (parsed?.[2] === undefined ? undefined : Number(parsed[2]));
    if (iid === undefined || !Number.isFinite(iid)) {
      return { queued: false, detail: `gitlab adapter: no merge request iid in ${pr.url}` };
    }
    const project = parsed?.[1] ?? this.project;
    try {
      const result = await this.glab(["mr", "merge", String(iid), "--auto-merge", "--yes"], project);
      const state = asRecord(this.parseJson(result.stdout))?.state;
      return {
        queued: true,
        detail: typeof state === "string" ? `auto-merge enabled (${state})` : "auto-merge enabled",
      };
    } catch (err) {
      return { queued: false, detail: err instanceof Error ? err.message : String(err) };
    }
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

  private ticketFromJson(raw: unknown, project: string): Ticket {
    const rec = asRecord(raw) ?? {};
    const iid = Number(rec.iid);
    const rawBody = typeof rec.description === "string" ? rec.description : "";
    const labels = labelNames(rec.labels);
    const ticket: Ticket = {
      ref: { tracker: "gitlab", id: `${project}#${iid}` },
      title: typeof rec.title === "string" ? rec.title : "",
      body: sanitizeTicketText(rawBody),
      labels,
      author: usernameOf(rec.author),
      raw,
    };
    if (typeof rec.web_url === "string") ticket.url = rec.web_url;
    if (typeof rec.state === "string") ticket.state = rec.state.toLowerCase();
    const assignees = assigneesOf(rec.assignees);
    if (assignees.length > 0) ticket.assignees = assignees;
    if (typeof rec.updated_at === "string") ticket.updatedAt = rec.updated_at;
    const kindLabel = labels.find((l) => l.startsWith("factory:kind="));
    if (kindLabel !== undefined) {
      const kind = kindLabel.slice("factory:kind=".length);
      if (isTicketKind(kind)) ticket.kind = kind;
    }
    return ticket;
  }

  private requireParts(ref: TicketRef): { project: string; iid: number } {
    if (ref.tracker !== "gitlab") throw new Error(`gitlab adapter: not a gitlab ref: ${ref.tracker}:${ref.id}`);
    const parsed = parseGitLabRef(ref.id, this.project);
    const parts = parsed === null ? null : splitGitLabId(parsed.id);
    if (parts === null) throw new Error(`gitlab adapter: malformed id: ${ref.id}`);
    return parts;
  }

  private parseJson(text: string): unknown {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    return JSON.parse(trimmed) as unknown;
  }

  private async glab(args: readonly string[], project?: string): Promise<HostCliResult> {
    const argv = ["glab", ...args, ...(project === undefined ? [] : ["--repo", project])];
    const result = await this.cli.exec(argv);
    if (result.code !== 0) throw new HostCliError(argv, result);
    return result;
  }
}
