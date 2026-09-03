export const TICKET_KINDS = ["feature", "enhancement", "bug", "chore"] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

export interface TicketRef {
  /** Adapter id: "local" in v0; "github" | "azure-devops" | "jira" in later releases. */
  tracker: string;
  /** Tracker-native id. For "local" this is the full `local-<ulid>` string. For GitHub: `owner/repo#n`. */
  id: string;
}

export interface TicketSummary {
  ref: TicketRef;
  title: string;
  state?: string;
  updatedAt?: string;
  url?: string;
}

export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  role?: string;
}

export type CommentId = string;

export interface PRRef {
  repo: string;
  number: number;
  url?: string;
  head?: string;
}

export type TrackerCapability = "editComment" | "reactions" | "transition" | "linkPR" | "nativeQuery";

export interface Ticket {
  ref: TicketRef;
  title: string;
  body: string;
  labels: string[];
  author: string;
  url?: string;
  kind?: TicketKind;
  state?: string;
  assignees?: string[];
  updatedAt?: string;
  priority?: string;
  similar?: TicketSummary[];
  raw?: unknown;
}

/** Spec §3.1 adapter. Host-side only; workers never call tracker CLIs. `comment` still returns null when there is no stream. */
export interface TrackerAdapter {
  readonly id: string;
  readonly capabilities: Set<TrackerCapability>;
  detect(): Promise<{ available: boolean; reason?: string }>;
  parseRef(input: string): TicketRef | null;
  fetch(ref: TicketRef): Promise<Ticket>;
  list(q: { label: string; state: string; updatedSince?: Date }): Promise<Ticket[]>;
  search(q: { titleTokens: string[] }): Promise<TicketSummary[]>;
  getComments(ref: TicketRef, since?: Date): Promise<Comment[]>;
  labelerOf(ref: TicketRef, label: string): Promise<{ login: string; role: string } | null>;
  isAuthorized(login: string): Promise<boolean>;
  acknowledge(ref: TicketRef): Promise<void>;
  comment(ref: TicketRef, body: string, opts: { idempotencyKey: string }): Promise<CommentId | null>;
  editComment?(ref: TicketRef, id: CommentId, body: string): Promise<void>;
  addLabel(ref: TicketRef, label: string): Promise<void>;
  removeLabel(ref: TicketRef, label: string): Promise<void>;
  transition(ref: TicketRef, target: string): Promise<void>;
  assign(ref: TicketRef, user: string): Promise<void>;
  linkPR(ref: TicketRef, pr: PRRef): Promise<void>;
  prHint?(pr: PRRef): Promise<{ state?: string; mergeCommit?: string }>;
}

export function isTicketKind(value: unknown): value is TicketKind {
  return typeof value === "string" && (TICKET_KINDS as readonly string[]).includes(value);
}

/** String form stored in RunState.ticket.ref. */
export function refToString(ref: TicketRef): string {
  return ref.tracker === "local" ? ref.id : `${ref.tracker}:${ref.id}`;
}
