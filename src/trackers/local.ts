import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Comment,
  CommentId,
  PRRef,
  Ticket,
  TicketKind,
  TicketRef,
  TicketSummary,
  TrackerAdapter,
  TrackerCapability,
} from "./adapter.js";
import { ulid as defaultUlid } from "./ulid.js";

export const LOCAL_TICKET_STATUSES = ["queued", "running", "done", "failed"] as const;
export type LocalTicketStatus = (typeof LOCAL_TICKET_STATUSES)[number];

export interface LocalTicketRecord {
  schemaVersion: 1;
  ticket: Ticket;
  status: LocalTicketStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LocalAdapterOptions {
  author?: string;
  ulid?: () => string;
  now?: () => Date;
}

const LOCAL_REF = /^local-[0-9A-HJKMNP-TV-Z]{26}$/;
const TITLE_MAX = 72;

export function localTicketsDir(runsDir: string): string {
  return join(runsDir, "_factory", "local-tickets");
}

export function deriveTitle(body: string): string {
  const first =
    body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "untitled task";
  const title = first.replace(/^#+\s*/, "");
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 3)}...` : title;
}

/**
 * Tracker adapter for freeform `/factory enqueue --task` work. Tickets live at
 * `<runsDir>/_factory/local-tickets/<id>.json`; there is no comment stream, so
 * write-backs for local tasks go to the TUI and the run dir only (spec §3.10).
 */
export class LocalAdapter implements TrackerAdapter {
  readonly id = "local";
  readonly capabilities: Set<TrackerCapability> = new Set();
  readonly dir: string;
  private readonly author: string;
  private readonly mint: () => string;
  private readonly now: () => Date;

  constructor(runsDir: string, opts: LocalAdapterOptions = {}) {
    this.dir = localTicketsDir(runsDir);
    this.author = opts.author ?? "operator";
    this.mint = opts.ulid ?? defaultUlid;
    this.now = opts.now ?? (() => new Date());
  }

  parseRef(input: string): TicketRef | null {
    const trimmed = input.trim();
    return LOCAL_REF.test(trimmed) ? { tracker: "local", id: trimmed } : null;
  }

  async createFromTask(text: string, opts: { kind?: TicketKind; title?: string } = {}): Promise<Ticket> {
    const body = text.replace(/\r\n?/g, "\n").trim();
    if (body.length === 0) throw new Error("local ticket: task text is empty");
    const id = `local-${this.mint()}`;
    const ticket: Ticket = {
      ref: { tracker: "local", id },
      title: opts.title ?? deriveTitle(body),
      body,
      labels: [],
      author: this.author,
    };
    if (opts.kind !== undefined) ticket.kind = opts.kind;
    const at = this.now().toISOString();
    await this.write({ schemaVersion: 1, ticket, status: "queued", createdAt: at, updatedAt: at });
    return ticket;
  }

  async detect(): Promise<{ available: boolean; reason?: string }> {
    return { available: true };
  }

  async fetch(ref: TicketRef): Promise<Ticket> {
    return (await this.read(ref)).ticket;
  }

  async list(_q: { label: string; state: string; updatedSince?: Date }): Promise<Ticket[]> {
    return [];
  }

  async search(_q: { titleTokens: string[] }): Promise<TicketSummary[]> {
    return [];
  }

  async getComments(_ref: TicketRef, _since?: Date): Promise<Comment[]> {
    return [];
  }

  async labelerOf(_ref: TicketRef, _label: string): Promise<{ login: string; role: string } | null> {
    return null;
  }

  async isAuthorized(_login: string): Promise<boolean> {
    return false;
  }

  async acknowledge(_ref: TicketRef): Promise<void> {}

  async addLabel(_ref: TicketRef, _label: string): Promise<void> {}

  async removeLabel(_ref: TicketRef, _label: string): Promise<void> {}

  async transition(_ref: TicketRef, _target: string): Promise<void> {}

  async assign(_ref: TicketRef, _user: string): Promise<void> {}

  async linkPR(_ref: TicketRef, _pr: PRRef): Promise<void> {}

  async listRecords(filter: { status?: LocalTicketStatus } = {}): Promise<LocalTicketRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const records: LocalTicketRecord[] = [];
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
      const record = JSON.parse(await readFile(join(this.dir, name), "utf8")) as LocalTicketRecord;
      if (filter.status === undefined || record.status === filter.status) records.push(record);
    }
    return records;
  }

  async setStatus(ref: TicketRef, status: LocalTicketStatus): Promise<void> {
    const record = await this.read(ref);
    record.status = status;
    record.updatedAt = this.now().toISOString();
    await this.write(record);
  }

  async comment(_ref: TicketRef, _body: string, _opts: { idempotencyKey: string }): Promise<CommentId | null> {
    return null;
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async read(ref: TicketRef): Promise<LocalTicketRecord> {
    if (ref.tracker !== "local" || !LOCAL_REF.test(ref.id)) {
      throw new Error(`local ticket: not a local ref: ${ref.tracker}:${ref.id}`);
    }
    try {
      return JSON.parse(await readFile(this.pathFor(ref.id), "utf8")) as LocalTicketRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`local ticket not found: ${ref.id}`);
      throw err;
    }
  }

  private async write(record: LocalTicketRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = this.pathFor(record.ticket.ref.id);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  }
}
