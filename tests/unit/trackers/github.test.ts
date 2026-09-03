import { describe, it, expect } from "vitest";
import { GitHubAdapter } from "../../../src/trackers/github.js";
import { makeStubGh, type StubGhScript } from "../../helpers/stub-gh.js";

const REF = { tracker: "github", id: "acme/widgets#42" } as const;

const ISSUE = {
  number: 42,
  title: "Widgets rattle",
  body: "Hello <!-- hidden --> world\u200d",
  labels: ["factory:ready"],
  author: "ada",
  updatedAt: "2026-09-01T00:00:00.000Z",
  url: "https://github.com/acme/widgets/issues/42",
  state: "open",
};

function adapterFor(script: StubGhScript): GitHubAdapter {
  return new GitHubAdapter({ exec: makeStubGh(script), repo: "acme/widgets" });
}

describe("GitHubAdapter.parseRef", () => {
  const adapter = adapterFor({});

  it("accepts owner/repo#n, github: prefix, and github issue URLs", () => {
    expect(adapter.parseRef("acme/widgets#42")).toEqual(REF);
    expect(adapter.parseRef("github:acme/widgets#42")).toEqual(REF);
    expect(adapter.parseRef("https://github.com/acme/widgets/issues/42")).toEqual(REF);
    expect(adapter.parseRef("https://github.com/acme/widgets/issues/42/")).toEqual(REF);
  });

  it("rejects local ulids, azure urls, and a bare #n", () => {
    expect(adapter.parseRef("local-01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeNull();
    expect(adapter.parseRef("https://dev.azure.com/org/project/_workitems/edit/42")).toBeNull();
    expect(adapter.parseRef("#42")).toBeNull();
    expect(adapter.parseRef("42")).toBeNull();
  });
});

describe("GitHubAdapter fetch/list/comment/detect", () => {
  it("fetch and list return sanitized bodies and keep the original on raw", async () => {
    const script: StubGhScript = { issues: { "acme/widgets#42": { ...ISSUE } } };
    const adapter = adapterFor(script);
    const ticket = await adapter.fetch(REF);
    expect(ticket.ref).toEqual(REF);
    expect(ticket.body).toContain("Hello");
    expect(ticket.body).toContain("world");
    expect(ticket.body).not.toContain("<!--");
    expect(ticket.body).not.toContain("\u200d");
    expect((ticket.raw as { body: string }).body).toContain("<!-- hidden -->");

    const listed = await adapter.list({ label: "factory:ready", state: "open" });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.body).not.toContain("<!--");
    expect((listed[0]?.raw as { body: string }).body).toContain("<!-- hidden -->");
  });

  it("passes --repo acme/widgets on every gh invocation", async () => {
    const script: StubGhScript = { issues: { "acme/widgets#42": { ...ISSUE } }, calls: [] };
    const adapter = adapterFor(script);
    await adapter.fetch(REF);
    await adapter.list({ label: "factory:ready", state: "open" });
    expect(script.calls?.length).toBeGreaterThan(0);
    for (const argv of script.calls ?? []) {
      const i = argv.indexOf("--repo");
      expect(i).toBeGreaterThan(-1);
      expect(argv[i + 1]).toBe("acme/widgets");
    }
  });

  it("does not post twice for the same idempotencyKey", async () => {
    const script: StubGhScript = { issues: { "acme/widgets#42": { ...ISSUE } }, comments: {}, calls: [] };
    const adapter = adapterFor(script);
    const first = await adapter.comment(REF, "hello", { idempotencyKey: "k1" });
    const postsAfterFirst = (script.calls ?? []).filter((c) => c[0] === "issue" && c[1] === "comment").length;
    const second = await adapter.comment(REF, "hello again", { idempotencyKey: "k1" });
    const postsAfterSecond = (script.calls ?? []).filter((c) => c[0] === "issue" && c[1] === "comment").length;
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(postsAfterFirst).toBe(1);
    expect(postsAfterSecond).toBe(1);
  });

  it("detect failure disables the adapter with stderr as reason", async () => {
    const adapter = new GitHubAdapter({
      exec: makeStubGh({ authStatus: { code: 1, stdout: "", stderr: "gh: not logged in" } }),
      repo: "acme/widgets",
    });
    const detected = await adapter.detect();
    expect(detected.available).toBe(false);
    expect(detected.reason).toMatch(/not logged in/);
  });

  it("detect is cached per instance", async () => {
    const script: StubGhScript = { authStatus: { code: 0, stdout: "logged in" }, calls: [] };
    const adapter = adapterFor(script);
    expect((await adapter.detect()).available).toBe(true);
    expect((await adapter.detect()).available).toBe(true);
    const authCalls = (script.calls ?? []).filter((c) => c[0] === "auth");
    expect(authCalls).toHaveLength(1);
  });
});
