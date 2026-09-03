import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_V3_POLICY } from "../../../src/v3/dispatch.js";
import {
  createWebhookHandler,
  parseWebhook,
  registerWebhooks,
  verifyWebhook,
  type WebhookHandler,
} from "../../../src/v3/webhooks.js";

const SECRET = "test-webhook-secret";

function src(): string {
  return readFileSync(fileURLToPath(new URL("../../../src/v3/webhooks.ts", import.meta.url)), "utf8");
}

function hmacHex(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const GITHUB_BODY = JSON.stringify({
  action: "labeled",
  issue: { number: 12, html_url: "https://github.com/acme/widgets/issues/12" },
  repository: { full_name: "acme/widgets" },
});

const GITLAB_BODY = JSON.stringify({
  object_kind: "issue",
  object_attributes: { iid: 7, action: "open", url: "https://gitlab.com/g/p/-/issues/7" },
  project: { path_with_namespace: "g/p" },
});

const LINEAR_BODY = JSON.stringify({
  action: "update",
  type: "Issue",
  data: { identifier: "LIN-123", id: "issue-uuid" },
});

describe("verifyWebhook", () => {
  it("rejects a bad HMAC and accepts GitHub sha256 signatures", () => {
    const bad = verifyWebhook({ "X-Hub-Signature-256": "sha256=deadbeef" }, GITHUB_BODY, SECRET);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/hmac|signature/i);

    const good = verifyWebhook({ "X-Hub-Signature-256": `sha256=${hmacHex(GITHUB_BODY)}` }, GITHUB_BODY, SECRET);
    expect(good.ok).toBe(true);
  });

  it("accepts GitLab token and Linear HMAC headers", () => {
    expect(verifyWebhook({ "X-Gitlab-Token": SECRET }, GITLAB_BODY, SECRET).ok).toBe(true);
    expect(verifyWebhook({ "X-Gitlab-Token": "nope" }, GITLAB_BODY, SECRET).ok).toBe(false);
    expect(verifyWebhook({ "Linear-Signature": hmacHex(LINEAR_BODY) }, LINEAR_BODY, SECRET).ok).toBe(true);
  });

  it("rejects timestamps older than 5 minutes when a timestamp header exists", () => {
    const stale = Math.floor(Date.now() / 1000) - 400;
    const body = GITHUB_BODY;
    const result = verifyWebhook(
      {
        "X-Hub-Signature-256": `sha256=${hmacHex(body)}`,
        "X-Hub-Timestamp": String(stale),
      },
      body,
      SECRET,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/replay|timestamp/i);
  });
});

describe("parseWebhook", () => {
  it("parses GitHub, GitLab, and Linear issue shapes", () => {
    expect(parseWebhook("github", GITHUB_BODY)).toEqual({
      ref: { tracker: "github", id: "acme/widgets#12" },
      action: "labeled",
    });
    expect(parseWebhook("gitlab", GITLAB_BODY)).toEqual({
      ref: { tracker: "gitlab", id: "g/p#7" },
      action: "open",
    });
    expect(parseWebhook("linear", LINEAR_BODY)).toEqual({
      ref: { tracker: "linear", id: "LIN-123" },
      action: "update",
    });
    expect(parseWebhook("github", "{")).toBeNull();
  });
});

describe("createWebhookHandler", () => {
  it("throws when constructed without a secret", () => {
    expect(() => createWebhookHandler({ secret: "", onEvent: async () => {} })).toThrow(/secret/i);
    expect(() => createWebhookHandler({ secret: "   ", onEvent: async () => {} })).toThrow(/secret/i);
  });

  it("returns 401 on bad HMAC and does not call onEvent", async () => {
    const events: string[] = [];
    const handler = createWebhookHandler({
      secret: SECRET,
      onEvent: async (e) => {
        events.push(e.ref.id);
      },
    });
    const res = await handler({
      headers: { "X-Gitlab-Token": "wrong", "X-Gitlab-Event": "Issue Hook" },
      rawBody: GITLAB_BODY,
    });
    expect(res.status).toBe(401);
    expect(events).toEqual([]);
  });

  it("calls onEvent once for a good HMAC GitLab issue event", async () => {
    const events: Array<{ tracker: string; id: string }> = [];
    const handler = createWebhookHandler({
      secret: SECRET,
      onEvent: async (e) => {
        events.push(e.ref);
      },
    });
    const res = await handler({
      headers: { "X-Gitlab-Token": SECRET, "X-Gitlab-Event": "Issue Hook" },
      rawBody: GITLAB_BODY,
    });
    expect(res.status).toBe(200);
    expect(events).toEqual([{ tracker: "gitlab", id: "g/p#7" }]);
  });

  it("handles GitHub HMAC and Linear HMAC event shapes", async () => {
    const events: string[] = [];
    const handler = createWebhookHandler({
      secret: SECRET,
      onEvent: async (e) => {
        events.push(`${e.ref.tracker}:${e.ref.id}`);
      },
    });
    const gh = await handler({
      headers: {
        "X-Hub-Signature-256": `sha256=${hmacHex(GITHUB_BODY)}`,
        "X-GitHub-Event": "issues",
      },
      rawBody: GITHUB_BODY,
    });
    const lin = await handler({
      headers: { "Linear-Signature": hmacHex(LINEAR_BODY) },
      rawBody: LINEAR_BODY,
    });
    expect(gh.status).toBe(200);
    expect(lin.status).toBe(200);
    expect(events).toEqual(["github:acme/widgets#12", "linear:LIN-123"]);
  });
});

describe("registerWebhooks", () => {
  it("does not bind a listener when the flag is off", () => {
    let listens = 0;
    const result = registerWebhooks({
      cfg: { v3: DEFAULT_V3_POLICY },
      drainOnce: async () => ({ claimed: 0, skipped: 0 }),
      listen: () => {
        listens += 1;
        return { close() {} };
      },
    });
    expect(result.listening).toBe(false);
    expect(listens).toBe(0);
  });

  it("does not bind when the flag is on but the secret is missing", () => {
    let listens = 0;
    const result = registerWebhooks({
      cfg: { v3: { webhooks: { enabled: true } } },
      drainOnce: async () => ({ claimed: 0, skipped: 0 }),
      listen: () => {
        listens += 1;
        return { close() {} };
      },
    });
    expect(result).toEqual({ listening: false, reason: "missing-secret" });
    expect(listens).toBe(0);
  });

  it("accelerates drainOnce and never claims or labels", async () => {
    let handler: WebhookHandler | undefined;
    const drains: number[] = [];
    const labels: string[] = [];
    const addLabel = (x: string) => labels.push(x);
    const result = registerWebhooks({
      cfg: { v3: { webhooks: { enabled: true, secret: SECRET } } },
      drainOnce: async () => {
        drains.push(1);
        return { claimed: 0, skipped: 0 };
      },
      listen: (h) => {
        handler = h;
        return { close() {} };
      },
    });
    expect(result.listening).toBe(true);
    expect(handler).toBeTypeOf("function");
    await handler!({
      headers: { "X-Gitlab-Token": SECRET, "X-Gitlab-Event": "Issue Hook" },
      rawBody: GITLAB_BODY,
    });
    expect(drains).toEqual([1]);
    expect(labels).toEqual([]);
    void addLabel;
    expect(src()).not.toMatch(/addLabel|claimTicket|createServer/);
    expect(src()).not.toMatch(/from ["']node:http["']/);
  });
});
