import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AzureDevOpsAdapter } from "../../../src/trackers/azure-devops.js";
import { JiraAdapter } from "../../../src/trackers/jira.js";
import { recordUnauthorized } from "../../../src/trackers/screen.js";
import { createFakeCli, type HostCliResult } from "../../../src/trackers/host-cli.js";

function json(value: unknown, code = 0): HostCliResult {
  return { stdout: `${JSON.stringify(value)}\n`, stderr: "", code };
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v !== undefined && !v.startsWith("-") ? v : undefined;
}

describe("AzureDevOpsAdapter roles", () => {
  function make(opts: { allow: Record<string, boolean | "error">; allowedAuthors: string[] }) {
    const calls: string[][] = [];
    const cli = createFakeCli((argv) => {
      calls.push([...argv]);
      if (argv[1] === "rest" && /updates/.test(flag(argv, "--uri") ?? "")) {
        return json({
          value: [
            {
              revisedBy: { uniqueName: "ada@contoso" },
              fields: { "System.Tags": { oldValue: "", newValue: "factory:ready" } },
            },
          ],
        });
      }
      if (argv[1] === "rest") {
        const uri = flag(argv, "--uri") ?? "";
        const subject = /[?&]subject=([^&]+)/.exec(uri)?.[1];
        const login = decodeURIComponent(subject ?? "");
        const row = opts.allow[login] ?? opts.allow[login.split("@")[0] ?? ""];
        if (row === "error") return { stdout: "", stderr: "boom", code: 1 };
        return json({ allow: row === true });
      }
      if (argv[1] === "boards" && argv[3] === "show") {
        return json({
          id: 42,
          fields: {
            "System.Title": "x",
            "System.Tags": "factory:ready",
            "System.CreatedBy": { uniqueName: "ada@contoso" },
          },
        });
      }
      if (argv[1] === "issue" || argv[1] === "rest") return json({});
      return { stdout: "", stderr: `unhandled ${argv.join(" ")}`, code: 1 };
    });
    const adapter = new AzureDevOpsAdapter({
      org: "contoso",
      project: "widgets",
      allowedAuthors: opts.allowedAuthors,
      cli,
    });
    return { adapter, calls };
  }

  it("authorizes ada when allowlist and role pass", async () => {
    const { adapter } = make({ allow: { "ada@contoso": true, ada: true }, allowedAuthors: ["ada@contoso"] });
    expect(await adapter.isAuthorized("ada@contoso")).toBe(true);
  });

  it("denies mallory on the allowlist when the role API denies", async () => {
    const { adapter } = make({
      allow: { "mallory@contoso": false, mallory: false, "ada@contoso": true },
      allowedAuthors: ["ada@contoso", "mallory@contoso"],
    });
    expect(await adapter.isAuthorized("mallory@contoso")).toBe(false);
  });

  it("denies mallory off the allowlist even when the role fixture allows", async () => {
    const { adapter } = make({
      allow: { "mallory@contoso": true, mallory: true },
      allowedAuthors: ["ada@contoso"],
    });
    expect(await adapter.isAuthorized("mallory@contoso")).toBe(false);
  });

  it("fail-closes when the role API errors", async () => {
    const { adapter } = make({ allow: { "ada@contoso": "error", ada: "error" }, allowedAuthors: ["ada@contoso"] });
    expect(await adapter.isAuthorized("ada@contoso")).toBe(false);
  });

  it("labelerOf returns the last actor who added factory:ready", async () => {
    const { adapter } = make({ allow: { "ada@contoso": true }, allowedAuthors: ["ada@contoso"] });
    expect(await adapter.labelerOf({ tracker: "azure-devops", id: "42" }, "factory:ready")).toEqual({
      login: "ada@contoso",
      role: "allowlist",
    });
  });

  it("does not comment when unauthorized; records ledger", async () => {
    const { adapter, calls } = make({
      allow: { "mallory@contoso": false },
      allowedAuthors: ["mallory@contoso"],
    });
    const runsDir = await mkdtemp(join(tmpdir(), "pi-sdlc-unauth-ado-"));
    try {
      const login = "mallory@contoso";
      const ok = await adapter.isAuthorized(login);
      expect(ok).toBe(false);
      if (ok) await adapter.comment({ tracker: "azure-devops", id: "42" }, "hi", { idempotencyKey: "claim" });
      else {
        await recordUnauthorized(runsDir, {
          tracker: "azure-devops",
          ref: "42",
          login,
        });
      }
      expect(calls.some((c) => c.includes("POST") || c[2] === "comment")).toBe(false);
      const lines = (await readFile(join(runsDir, "_factory", "ledger.jsonl"), "utf8")).trim().split("\n");
      expect(JSON.parse(lines[0]!)).toMatchObject({
        type: "unauthorized-trigger",
        tracker: "azure-devops",
        ref: "42",
        login,
      });
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  });
});

describe("JiraAdapter roles", () => {
  function make(opts: { allow: Record<string, boolean | "error">; allowedAuthors: string[] }) {
    const calls: string[][] = [];
    const cli = createFakeCli((argv) => {
      calls.push([...argv]);
      if (argv[1] === "api" || (argv[1] === "rest" && argv[2] === "GET")) {
        const path = argv.find((a) => a.startsWith("/rest/")) ?? "";
        const q = /accountId=([^&]+)/.exec(path)?.[1] ?? "";
        const login = decodeURIComponent(q);
        const handle = login.split("@")[0] ?? login;
        const row = opts.allow[login] ?? opts.allow[handle];
        if (row === "error") return { stdout: "", stderr: "jira 500", code: 1 };
        return json({
          permissions: {
            EDIT_ISSUES: { havePermission: row === true },
            TRANSITION_ISSUES: { havePermission: row === true },
          },
        });
      }
      if (argv[1] === "issue" && argv[2] === "list") {
        return json([
          {
            key: "DEMO-1",
            fields: {
              summary: "x",
              labels: ["factory:ready"],
              reporter: { emailAddress: "ada@example.com", accountId: "ada" },
              status: { name: "To Do" },
            },
            changelog: {
              histories: [
                {
                  author: { emailAddress: "ada@example.com", accountId: "ada" },
                  items: [{ field: "labels", toString: "factory:ready" }],
                },
              ],
            },
          },
        ]);
      }
      if (argv[1] === "issue" && argv[2] === "comment") return json({ id: "9" });
      return { stdout: "", stderr: `unhandled ${argv.join(" ")}`, code: 1 };
    });
    const adapter = new JiraAdapter({
      site: "https://example.atlassian.net",
      projectKey: "DEMO",
      allowedAuthors: opts.allowedAuthors,
      cli,
    });
    return { adapter, calls };
  }

  it("authorizes ada when allowlist and EDIT_ISSUES pass", async () => {
    const { adapter } = make({ allow: { ada: true, "ada@example.com": true }, allowedAuthors: ["ada@example.com"] });
    expect(await adapter.isAuthorized("ada@example.com")).toBe(true);
  });

  it("denies mallory on the allowlist when role denies", async () => {
    const { adapter } = make({
      allow: { mallory: false, "mallory@example.com": false },
      allowedAuthors: ["mallory@example.com"],
    });
    expect(await adapter.isAuthorized("mallory@example.com")).toBe(false);
  });

  it("denies mallory off the allowlist even if role allows", async () => {
    const { adapter } = make({
      allow: { mallory: true, "mallory@example.com": true },
      allowedAuthors: ["ada@example.com"],
    });
    expect(await adapter.isAuthorized("mallory@example.com")).toBe(false);
  });

  it("fail-closes on API error", async () => {
    const { adapter } = make({ allow: { ada: "error", "ada@example.com": "error" }, allowedAuthors: ["ada@example.com"] });
    expect(await adapter.isAuthorized("ada")).toBe(false);
  });

  it("labelerOf reads changelog for factory:ready", async () => {
    const { adapter } = make({ allow: { ada: true }, allowedAuthors: ["ada@example.com"] });
    expect(await adapter.labelerOf({ tracker: "jira", id: "DEMO-1" }, "factory:ready")).toEqual({
      login: "ada@example.com",
      role: "allowlist",
    });
  });

  it("does not post a comment when unauthorized", async () => {
    const { adapter, calls } = make({
      allow: { mallory: false },
      allowedAuthors: ["mallory@example.com"],
    });
    const ok = await adapter.isAuthorized("mallory@example.com");
    expect(ok).toBe(false);
    if (ok) await adapter.comment({ tracker: "jira", id: "DEMO-1" }, "nope", { idempotencyKey: "claim" });
    expect(calls.some((c) => c[2] === "comment")).toBe(false);
  });
});
