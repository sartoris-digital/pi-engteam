import { describe, it, expect } from "vitest";
import { GitHubAdapter } from "../../../src/trackers/github.js";
import { makeStubGh, type StubGhScript } from "../../helpers/stub-gh.js";

const REF = { tracker: "github", id: "acme/widgets#42" } as const;

const ISSUE = {
  number: 42,
  title: "Widgets rattle",
  body: "They rattle when dropped.",
  labels: ["factory:ready"],
  author: "ada",
  updatedAt: "2026-09-01T00:00:00.000Z",
  url: "https://github.com/acme/widgets/issues/42",
  state: "open",
};

function makeAdapter(script: StubGhScript, extra?: { allowedLabelers?: string[]; ignoreAuthors?: string[] }): GitHubAdapter {
  return new GitHubAdapter({
    exec: makeStubGh(script),
    repo: "acme/widgets",
    ...extra,
  });
}

describe("GitHubAdapter authorization", () => {
  it("authorizes role_name write and rejects read", async () => {
    const adapter = makeAdapter({
      issues: { "acme/widgets#42": { ...ISSUE } },
      collab: { ada: { role_name: "write" }, bob: { role_name: "read" } },
    });
    expect(await adapter.isAuthorized("ada")).toBe(true);
    expect(await adapter.isAuthorized("bob")).toBe(false);
  });

  it("uses role_name rather than permission", async () => {
    const adapter = makeAdapter({
      collab: { ada: { role_name: "read", permission: "write" } },
    });
    expect(await adapter.isAuthorized("ada")).toBe(false);
  });

  it("authorizes an allowlisted login even when role_name is read", async () => {
    const adapter = makeAdapter(
      { collab: { eve: { role_name: "read" } } },
      { allowedLabelers: ["eve"] },
    );
    expect(await adapter.isAuthorized("eve")).toBe(true);
  });

  it("labelerOf returns the most recent labeled event for that label", async () => {
    const adapter = makeAdapter({
      events: {
        "acme/widgets#42": [
          { event: "labeled", actor: { login: "old" }, label: { name: "factory:ready" } },
          { event: "labeled", actor: { login: "other" }, label: { name: "bug" } },
          { event: "labeled", actor: { login: "fresh" }, label: { name: "factory:ready" } },
        ],
      },
      collab: { fresh: { role_name: "maintain" }, old: { role_name: "write" } },
    });
    expect(await adapter.labelerOf(REF, "factory:ready")).toEqual({ login: "fresh", role: "maintain" });
  });

  it("getComments drops bots and ignoreAuthors", async () => {
    const adapter = makeAdapter(
      {
        comments: {
          "acme/widgets#42": [
            { id: "1", author: "ada", body: "keep", createdAt: "2026-09-01T00:00:00.000Z" },
            { id: "2", author: "dependabot[bot]", body: "drop bot", createdAt: "2026-09-01T00:00:01.000Z" },
            { id: "3", author: "noisy", body: "drop ignore", createdAt: "2026-09-01T00:00:02.000Z" },
          ],
        },
      },
      { ignoreAuthors: ["noisy"] },
    );
    const comments = await adapter.getComments(REF);
    expect(comments.map((c) => c.author)).toEqual(["ada"]);
  });

  it("editComment PATCHes the issue comment and capabilities include editComment", async () => {
    const script: StubGhScript = {
      comments: {
        "acme/widgets#42": [{ id: "9", author: "factory", body: "old", createdAt: "2026-09-01T00:00:00.000Z" }],
      },
      calls: [],
    };
    const adapter = makeAdapter(script);
    expect(adapter.capabilities.has("editComment")).toBe(true);
    await adapter.editComment(REF, "9", "new body");
    const patch = (script.calls ?? []).find((c) => c.includes("-X") && c.includes("PATCH"));
    expect(patch).toBeDefined();
    expect(patch?.some((a) => a.includes("repos/acme/widgets/issues/comments/9"))).toBe(true);
  });
});
