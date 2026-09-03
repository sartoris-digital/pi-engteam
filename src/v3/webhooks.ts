// src/v3/webhooks.ts — HMAC webhook handler. No HTTP listen unless an injected listen is passed.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { TicketRef } from "../trackers/adapter.js";
import { v3Enabled, type V3HostConfig } from "./dispatch.js";

export type WebhookTrackerKind = "github" | "gitlab" | "linear" | "azure-devops" | "jira" | "mcp";

export interface WebhookEvent {
  ref: TicketRef;
  action: string;
}

export type WebhookHandler = (req: {
  headers: Record<string, string>;
  rawBody: string;
}) => Promise<{ status: number }>;

const REPLAY_MS = 5 * 60 * 1000;

function header(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

function safeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function parseTimestamp(value: string): number | null {
  const t = value.trim();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n < 1e12 ? n * 1000 : n;
  }
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifyWebhook(
  headers: Record<string, string>,
  rawBody: string,
  secret: string,
  now: () => Date = () => new Date(),
): { ok: boolean; reason?: string } {
  if (secret.trim() === "") return { ok: false, reason: "missing-secret" };
  const ts =
    header(headers, "x-hub-timestamp") ??
    header(headers, "x-webhook-timestamp") ??
    header(headers, "x-request-timestamp");
  if (ts !== undefined) {
    const ms = parseTimestamp(ts);
    if (ms === null) return { ok: false, reason: "bad-timestamp" };
    if (now().getTime() - ms > REPLAY_MS) return { ok: false, reason: "replay-window" };
  }

  const hub = header(headers, "x-hub-signature-256");
  if (hub !== undefined) {
    const hex = hub.trim().replace(/^sha256=/i, "").toLowerCase();
    const expected = hmacHex(secret, rawBody).toLowerCase();
    if (!safeEqualString(hex, expected)) return { ok: false, reason: "bad-hmac" };
    return { ok: true };
  }
  const linear = header(headers, "linear-signature") ?? header(headers, "x-linear-signature");
  if (linear !== undefined) {
    const expected = hmacHex(secret, rawBody).toLowerCase();
    if (!safeEqualString(linear.trim().toLowerCase(), expected)) return { ok: false, reason: "bad-hmac" };
    return { ok: true };
  }
  const gitlab = header(headers, "x-gitlab-token");
  if (gitlab !== undefined) {
    if (!safeEqualString(gitlab, secret)) return { ok: false, reason: "bad-hmac" };
    return { ok: true };
  }
  return { ok: false, reason: "missing-signature" };
}

function asRec(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseGithub(rec: Record<string, unknown>): WebhookEvent | null {
  const action = typeof rec.action === "string" ? rec.action : "";
  const repo = asRec(rec.repository);
  const full = typeof repo?.full_name === "string" ? repo.full_name : "";
  const issue = asRec(rec.issue) ?? asRec(rec.pull_request);
  const num = issue?.number;
  if (full === "" || typeof num !== "number") return null;
  return { ref: { tracker: "github", id: `${full}#${num}` }, action };
}

function parseGitlab(rec: Record<string, unknown>): WebhookEvent | null {
  const attrs = asRec(rec.object_attributes);
  const project = asRec(rec.project);
  const ns = typeof project?.path_with_namespace === "string" ? project.path_with_namespace : "";
  const iid = attrs?.iid;
  const action = typeof attrs?.action === "string" ? attrs.action : typeof rec.event_type === "string" ? rec.event_type : "";
  if (ns === "" || (typeof iid !== "number" && typeof iid !== "string")) return null;
  return { ref: { tracker: "gitlab", id: `${ns}#${iid}` }, action };
}

function parseLinear(rec: Record<string, unknown>): WebhookEvent | null {
  const data = asRec(rec.data);
  const ident = typeof data?.identifier === "string" ? data.identifier : "";
  const action = typeof rec.action === "string" ? rec.action : "";
  if (ident === "") return null;
  return { ref: { tracker: "linear", id: ident }, action };
}

export function parseWebhook(kind: string, rawBody: string): WebhookEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const rec = asRec(body);
  if (rec === null) return null;
  if (kind === "github") return parseGithub(rec);
  if (kind === "gitlab") return parseGitlab(rec);
  if (kind === "linear") return parseLinear(rec);
  return null;
}

function detectKind(headers: Record<string, string>): WebhookTrackerKind | undefined {
  if (header(headers, "x-github-event") !== undefined) return "github";
  if (header(headers, "x-gitlab-event") !== undefined || header(headers, "x-gitlab-token") !== undefined) {
    return "gitlab";
  }
  if (
    header(headers, "linear-signature") !== undefined ||
    header(headers, "x-linear-signature") !== undefined ||
    header(headers, "linear-event") !== undefined
  ) {
    return "linear";
  }
  return undefined;
}

function parseAny(rawBody: string): WebhookEvent | null {
  return parseWebhook("github", rawBody) ?? parseWebhook("gitlab", rawBody) ?? parseWebhook("linear", rawBody);
}

export function createWebhookHandler(opts: {
  secret: string;
  onEvent: (e: { ref: TicketRef }) => Promise<void>;
  kind?: WebhookTrackerKind;
  now?: () => Date;
}): WebhookHandler {
  if (opts.secret.trim() === "") throw new Error("webhook secret is required");
  return async (req) => {
    const verified = verifyWebhook(req.headers, req.rawBody, opts.secret, opts.now);
    if (!verified.ok) return { status: 401 };
    const kind = opts.kind ?? detectKind(req.headers);
    const parsed = kind !== undefined ? parseWebhook(kind, req.rawBody) : parseAny(req.rawBody);
    if (parsed === null) return { status: 204 };
    try {
      await opts.onEvent({ ref: parsed.ref });
    } catch {
      return { status: 500 };
    }
    return { status: 200 };
  };
}

export function registerWebhooks(opts: {
  cfg: V3HostConfig;
  drainOnce: () => Promise<unknown>;
  listen?: (handler: WebhookHandler) => { close(): void };
}): { listening: boolean; reason?: string; close?: () => void } {
  if (!v3Enabled(opts.cfg, "webhooks")) return { listening: false };
  const secret = opts.cfg.v3?.webhooks?.secret;
  if (secret === undefined || secret.trim() === "") return { listening: false, reason: "missing-secret" };
  if (opts.listen === undefined) return { listening: false, reason: "no-listen" };
  const handler = createWebhookHandler({
    secret,
    onEvent: async () => {
      await opts.drainOnce();
    },
  });
  const server = opts.listen(handler);
  return { listening: true, close: () => server.close() };
}
