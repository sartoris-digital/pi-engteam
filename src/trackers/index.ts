export { TICKET_KINDS, isTicketKind, refToString } from "./adapter.js";
export type {
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
export { LOCAL_TICKET_STATUSES, LocalAdapter, deriveTitle, localTicketsDir } from "./local.js";
export type { LocalAdapterOptions, LocalTicketRecord, LocalTicketStatus } from "./local.js";
