export const TICKET_KINDS = ["feature", "enhancement", "bug", "chore"] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

export interface TicketRef {
  /** Adapter id: "local" in v0; "github" | "azure-devops" | "jira" in later releases. */
  tracker: string;
  /** Tracker-native id. For "local" this is the full `local-<ulid>` string. */
  id: string;
}

export interface Ticket {
  ref: TicketRef;
  title: string;
  body: string;
  labels: string[];
  author: string;
  url?: string;
  kind?: TicketKind;
}

/** v0 subset of the spec §3.1 adapter: host-side only, operator credentials, no network in the local adapter. */
export interface TrackerAdapter {
  readonly id: string;
  parseRef(input: string): TicketRef | null;
  fetch(ref: TicketRef): Promise<Ticket>;
  /** Returns the tracker comment id, or null when the adapter has no comment stream. */
  comment(ref: TicketRef, body: string, opts: { idempotencyKey: string }): Promise<string | null>;
}

export function isTicketKind(value: unknown): value is TicketKind {
  return typeof value === "string" && (TICKET_KINDS as readonly string[]).includes(value);
}

/** String form stored in RunState.ticket.ref. */
export function refToString(ref: TicketRef): string {
  return ref.tracker === "local" ? ref.id : `${ref.tracker}:${ref.id}`;
}
