import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GitLabAdapter, parseGitLabRef } from "../../../src/trackers/gitlab.js";
import { createFakeCli, type HostCli, type HostCliResult } from "../../../src/trackers/host-cli.js";
import { buildWorkerEnv } from "../../../src/runtime/env.js";
import { makeWorkerRequest } from "../../helpers/worker-request.js";

const PROJECT = "g/p";
const REF = { tracker: "gitlab", id: "g/p#123" } as const;

const ISSUE = {
  iid: 123,
  id: 456,
  title: "Widgets rattle",
  description: "They rattle when dropped.",
  state: "opened",
  labels: ["factory:ready"],
  author: { username: "ada", name: "Ada" },
  web_url: "https://gitlab.com/g/p/-/issues/123",
  updated_at: "2026-09-01T00:00:00.000Z",
  assignees: [{ username: "ada" }],
};

function json(value: unknown, code = 0): HostCliResult {
  return { stdout: `${JSON.stringify(value)}\n`, stderr: "", code };
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v !== undefined && !v.startsWith("-") ? v : undefined;
}

function makeGlabCli(opts?: {
  access?: Record<string, number | "error">;
  authCode?: number;
}): { cli: HostCli; calls: string[][] } {
  const calls: string[][] = [];
  const access = opts?.access ?? { ada: 30, guest: 10 };
  const cli = createFakeCli((argv) => {
    calls.push([...argv]);
    if (argv[1] === "auth" && argv[2] === "status") {
      return { stdout: "Logged in", stderr: "", code: opts?.authCode ?? 0 };
    }
    if (argv[1] === "issue" && argv[2] === "view") return json(ISSUE);
    if (argv[1] === "issue" && argv[2] === "list") return json([ISSUE]);
    if (argv[1] === "issue" && argv[2] === "note") return json({ id: 99, body: "ok" });
    if (argv[1] === "issue" && argv[2] === "update") return json(ISSUE);
    if (argv[1] === "mr" && argv[2] === "merge") return json({ state: "merged" });
    if (argv[1] === "mr" && argv[2] === "update") return json({ iid: 9 });
    if (argv[1] === "mr" && argv[2] === "view") {
      return json({ state: "merged", merge_commit_sha: "abc123" });
    }
    if (argv[1] === "api") {
      const path = argv[2] ?? "";
      if (path.includes("resource_label_events")) {
        return json([
          { action: "add", user: { username: "old" }, label: { name: "factory:ready" } },
          { action: "add", user: { username: "other" }, label: { name: "bug" } },
          { action: "add", user: { username: "ada" }, label: { name: "factory:ready" } },
        ]);
      }
      if (path.includes("/notes")) {
        return json([
          { id: 1, body: "keep", created_at: "2026-09-01T00:00:00.000Z", author: { username: "ada" } },
          {
            id: 2,
            body: "drop bot",
            created_at: "2026-09-01T00:00:01.000Z",
            author: { username: "renovate[bot]" },
          },
        ]);
      }
      if (path.includes("members")) {
        const query = /[?&]query=([^&]+)/.exec(path)?.[1];
        const login = decodeURIComponent(query ?? "");
        const level = access[login];
        if (level === "error") return { stdout: "", stderr: "boom", code: 1 };
        if (typeof level === "number") return json([{ username: login, access_level: level }]);
        return json([]);
      }
    }
    return { stdout: "", stderr: `unhandled ${argv.join(" ")}`, code: 1 };
  });
  return { cli, calls };
}

function adapterFor(
  cli: HostCli,
  extra?: { enabled?: boolean; allowedLabelers?: string[]; project?: string },
): GitLabAdapter {
  return new GitLabAdapter({
    enabled: extra?.enabled ?? true,
    cli,
    project: extra?.project ?? PROJECT,
    ...(extra?.allowedLabelers === undefined ? {} : { allowedLabelers: extra.allowedLabelers }),
  });
}

describe("GitLabAdapter.parseRef", () => {
  const { cli } = makeGlabCli();
  const adapter = adapterFor(cli);

  it("accepts gitlab#123, g/p#123, and GitLab issue URLs", () => {
    expect(adapter.parseRef("gitlab#123")).toEqual(REF);
    expect(adapter.parseRef("g/p#123")).toEqual(REF);
    expect(adapter.parseRef("https://gitlab.com/g/p/-/issues/123")).toEqual(REF);
    expect(parseGitLabRef("gitlab:g/p#123")).toEqual(REF);
  });

  it("rejects Jira keys, Linear keys, and local ulids", () => {
    expect(adapter.parseRef("DEMO-1")).toBeNull();
    expect(adapter.parseRef("LIN-123")).toBeNull();
    expect(adapter.parseRef("local-01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeNull();
  });
});

describe("GitLabAdapter constructor", () => {
  it("refuses construction unless enabled is true", () => {
    const { cli } = makeGlabCli();
    expect(() => adapterFor(cli, { enabled: false })).toThrow(/v3\.gitlab\.enabled/);
    expect(() => new GitLabAdapter({ cli, project: PROJECT } as never)).toThrow(/v3\.gitlab\.enabled/);
  });

  it("does not call the transport until a method is invoked", () => {
    const { cli, calls } = makeGlabCli();
    const adapter = adapterFor(cli);
    expect(adapter.id).toBe("gitlab");
    expect(calls).toEqual([]);
  });

  it("sets id and capabilities including transition, linkPR, nativeQuery", () => {
    const { cli } = makeGlabCli();
    const adapter = adapterFor(cli);
    expect(adapter.id).toBe("gitlab");
    expect(adapter.capabilities.has("transition")).toBe(true);
    expect(adapter.capabilities.has("linkPR")).toBe(true);
    expect(adapter.capabilities.has("nativeQuery")).toBe(true);
  });
});

describe("GitLabAdapter fetch/list/labels", () => {
  it("fetch maps stub JSON to a Ticket and sanitizes the body", async () => {
    const { cli, calls } = makeGlabCli();
    const adapter = adapterFor(cli);
    const ticket = await adapter.fetch(REF);
    expect(ticket.ref).toEqual(REF);
    expect(ticket.title).toBe("Widgets rattle");
    expect(ticket.labels).toEqual(["factory:ready"]);
    expect(ticket.author).toBe("ada");
    expect(ticket.state).toBe("opened");
    expect(ticket.url).toBe("https://gitlab.com/g/p/-/issues/123");
    const view = calls.find((c) => c[1] === "issue" && c[2] === "view");
    expect(view).toEqual(expect.arrayContaining(["glab", "issue", "view", "123", "--output", "json"]));
  });

  it("list uses --label, --state opened, and --output json", async () => {
    const { cli, calls } = makeGlabCli();
    const adapter = adapterFor(cli);
    const listed = await adapter.list({ label: "factory:ready", state: "open" });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.ref).toEqual(REF);
    const list = calls.find((c) => c[1] === "issue" && c[2] === "list");
    expect(list).toEqual(
      expect.arrayContaining(["glab", "issue", "list", "--label", "factory:ready", "--state", "opened", "--output", "json"]),
    );
  });

  it("addLabel/removeLabel use --label / --unlabel", async () => {
    const { cli, calls } = makeGlabCli();
    const adapter = adapterFor(cli);
    await adapter.addLabel(REF, "factory:in-progress");
    await adapter.removeLabel(REF, "factory:ready");
    expect(calls.some((c) => c[2] === "update" && c.includes("--label") && c.includes("factory:in-progress"))).toBe(true);
    expect(calls.some((c) => c[2] === "update" && c.includes("--unlabel") && c.includes("factory:ready"))).toBe(true);
  });

  it("comment uses glab issue note", async () => {
    const { cli, calls } = makeGlabCli();
    const adapter = adapterFor(cli);
    const id = await adapter.comment(REF, "claimed", { idempotencyKey: "claim" });
    expect(id).toBeTruthy();
    expect(calls.some((c) => c[1] === "issue" && c[2] === "note")).toBe(true);
    const again = await adapter.comment(REF, "claimed again", { idempotencyKey: "claim" });
    expect(again).toBe(id);
    expect(calls.filter((c) => c[2] === "note")).toHaveLength(1);
  });

  it("linkPR uses glab mr update --related-issue", async () => {
    const { cli, calls } = makeGlabCli();
    const adapter = adapterFor(cli);
    await adapter.linkPR(REF, { repo: "g/p", number: 9, url: "https://gitlab.com/g/p/-/merge_requests/9" });
    expect(calls.some((c) => c[1] === "mr" && c[2] === "update" && c.includes("--related-issue") && c.includes("123"))).toBe(
      true,
    );
  });
});

describe("GitLabAdapter authorization", () => {
  it("isAuthorized is false for Guest and unknown roles", async () => {
    const { cli } = makeGlabCli({ access: { ada: 30, guest: 10 } });
    const adapter = adapterFor(cli);
    expect(await adapter.isAuthorized("ada")).toBe(true);
    expect(await adapter.isAuthorized("guest")).toBe(false);
    expect(await adapter.isAuthorized("nobody")).toBe(false);
  });

  it("authorizes allowedLabelers even when access_level is Guest", async () => {
    const { cli } = makeGlabCli({ access: { eve: 10 } });
    const adapter = adapterFor(cli, { allowedLabelers: ["eve"] });
    expect(await adapter.isAuthorized("eve")).toBe(true);
  });

  it("fails closed when the member API errors", async () => {
    const { cli } = makeGlabCli({ access: { ada: "error" } });
    const adapter = adapterFor(cli);
    expect(await adapter.isAuthorized("ada")).toBe(false);
  });

  it("labelerOf returns the most recent matching resource_label_events actor", async () => {
    const { cli } = makeGlabCli();
    const adapter = adapterFor(cli);
    expect(await adapter.labelerOf(REF, "factory:ready")).toEqual({ login: "ada", role: "member" });
  });
});

describe("GitLabAdapter enqueueMergeQueue", () => {
  it("includes --auto-merge and never emits a bare mr merge", async () => {
    const { cli, calls } = makeGlabCli();
    const adapter = adapterFor(cli);
    const result = await adapter.enqueueMergeQueue({
      url: "https://gitlab.com/g/p/-/merge_requests/9",
      number: 9,
    });
    expect(result.queued).toBe(true);
    const merge = calls.find((c) => c[1] === "mr" && c[2] === "merge");
    expect(merge).toBeDefined();
    expect(merge).toContain("--auto-merge");
    expect(merge).not.toEqual(["glab", "mr", "merge"]);
    expect(merge).not.toEqual(["glab", "mr", "merge", "9"]);
    for (const c of calls) {
      if (c[1] === "mr" && c[2] === "merge") {
        expect(c.includes("--auto-merge") || c.includes("--merge-train")).toBe(true);
      }
    }
  });
});

describe("GitLabAdapter detect", () => {
  it("uses glab auth status", async () => {
    const { cli, calls } = makeGlabCli();
    const adapter = adapterFor(cli);
    expect(await adapter.detect()).toEqual({ available: true });
    expect(calls[0]).toEqual(["glab", "auth", "status"]);
  });

  it("returns available:false with a reason on auth failure", async () => {
    const { cli } = makeGlabCli({ authCode: 1 });
    const adapter = adapterFor(cli);
    const result = await adapter.detect();
    expect(result.available).toBe(false);
    expect(result.reason?.length).toBeGreaterThan(0);
  });
});

describe("GitLabAdapter host-only", () => {
  it("does not import worker modules", async () => {
    const src = await readFile(fileURLToPath(new URL("../../../src/trackers/gitlab.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/from ["'][^"']*worker/);
  });

  it("worker env never carries GITLAB_TOKEN or GLAB tokens", () => {
    const env = buildWorkerEnv(
      {
        PATH: "/usr/bin",
        HOME: "/tmp",
        GITLAB_TOKEN: "gl-secret",
        GLAB_TOKEN: "glab-secret",
      },
      makeWorkerRequest(),
    );
    expect(env).not.toHaveProperty("GITLAB_TOKEN");
    expect(env).not.toHaveProperty("GLAB_TOKEN");
    expect(JSON.stringify(env)).not.toMatch(/gl-secret|glab-secret/);
  });
});
