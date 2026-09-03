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
export { sanitizeTicketText, stripTrackerPrior } from "./sanitize.js";
export type { TrackerPrior } from "./sanitize.js";
export { recordUnauthorized, screenText } from "./screen.js";
export type { ScreenFlags, UnauthorizedTrigger } from "./screen.js";
export { GhError, ensureRepoFlag, realGhExec } from "./gh.js";
export type { GhExec, GhResult } from "./gh.js";
export { GitHubAdapter, parseGitHubRef, splitGitHubId } from "./github.js";
export type { GitHubAdapterOptions } from "./github.js";
export { buildTrackerRegistry, detectTrackerFromRemote, githubConfigured } from "./discovery.js";
export type { TrackerRegistry } from "./discovery.js";
export { HostCliError, createFakeCli, createPathCli } from "./host-cli.js";
export type { HostCli, HostCliExecOptions, HostCliResult } from "./host-cli.js";
export { AzureDevOpsAdapter, parseAzureDevOpsRef, ticketLinkLine, workItemId } from "./azure-devops.js";
export type { AzureDevOpsAdapterOptions } from "./azure-devops.js";
export { JiraAdapter, parseJiraRef, ticketLinkLine as jiraTicketLinkLine } from "./jira.js";
export type { JiraAdapterOptions, JiraCommentMode } from "./jira.js";
export { GitLabAdapter, parseGitLabRef } from "./gitlab.js";
export type { GitLabAdapterOptions } from "./gitlab.js";
