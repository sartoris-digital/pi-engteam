import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { JiraAdapter, ticketLinkLine } from "../../../src/trackers/jira.js";
import { createFakeCli, type HostCli, type HostCliResult } from "../../../src/trackers/host-cli.js";
import { buildWorkerEnv } from "../../../src/runtime/env.js";
import { makeWorkerRequest } from "../../helpers/worker-request.js";

const REF = { tracker: "jira", id: "DEMO-1" } as const;

const ISSUE = {
  key: "DEMO-1",
  id: "10000",
  fields: {
    summary: "Widgets rattle",
    description: "They rattle when dropped.",
    labels: ["factory:ready"],
    status: { name: "To Do", statusCategory: { key: "new" } },
    reporter: { accountId: "ada", emailAddress: "ada@example.com", displayName: "Ada" },
    issuetype: { name: "Story" },
    updated: "2026-09-01T00:00:00.000Z",
  },
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

function makeJiraCli(): { cli: HostCli; calls: string[][] } {
  const calls: string[][] = [];
  const cli = createFakeCli((argv) => {
    calls.push([...argv]);
    if (argv[1] === "me") return json({ accountId: "ada", emailAddress: "ada@example.com" });
    if (argv[1] === "issue" && argv[2] === "list") return json([ISSUE]);
    if (argv[1] === "issue" && argv[2] === "comment" && argv[3] === "add") return json({ id: "10001" });
    if (argv[1] === "issue" && argv[2] === "move") return { stdout: "", stderr: "", code: 0 };
    if (argv[1] === "issue" && argv[2] === "edit") return { stdout: "", stderr: "", code: 0 };
    if (argv[1] === "issue" && argv[2] === "link") return { stdout: "", stderr: "", code: 0 };
    return { stdout: "", stderr: `unhandled ${argv.join(" ")}`, code: 1 };
  });
  return { cli, calls };
}

function adapterFor(
  cli: HostCli,
  extra?: { transitionOnClaim?: boolean; allowedAuthors?: string[]; commentMode?: "cadence" | "all" },
): JiraAdapter {
  return new JiraAdapter({
    site: "https://example.atlassian.net",
    projectKey: "DEMO",
    allowedAuthors: extra?.allowedAuthors ?? ["ada@example.com"],
    cli,
    ...(extra?.transitionOnClaim === undefined ? {} : { transitionOnClaim: extra.transitionOnClaim }),
    ...(extra?.commentMode === undefined ? {} : { commentMode: extra.commentMode }),
  });
}

describe("JiraAdapter.parseRef", () => {
  const { cli } = makeJiraCli();
  const adapter = adapterFor(cli);

  it("accepts DEMO-1 and jira:DEMO-1", () => {
    expect(adapter.parseRef("DEMO-1")).toEqual(REF);
    expect(adapter.parseRef("jira:DEMO-1")).toEqual(REF);
  });

  it("rejects AB#42 and local ids", () => {
    expect(adapter.parseRef("AB#42")).toBeNull();
    expect(adapter.parseRef("local-01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeNull();
  });

  it("ticketLinkLine is the issue key", () => {
    expect(ticketLinkLine(REF)).toBe("DEMO-1");
  });
});

describe("JiraAdapter constructor", () => {
  it("throws when allowedAuthors is empty", () => {
    const { cli } = makeJiraCli();
    expect(() => adapterFor(cli, { allowedAuthors: [] })).toThrow(/allowedAuthors/);
  });

  it("has transition/linkPR/nativeQuery and no editComment", () => {
    const { cli } = makeJiraCli();
    const adapter = adapterFor(cli);
    expect(adapter.id).toBe("jira");
    expect(adapter.capabilities.has("editComment")).toBe(false);
    expect(adapter.capabilities.has("transition")).toBe(true);
    expect(adapter.capabilities.has("linkPR")).toBe(true);
    expect(adapter.capabilities.has("nativeQuery")).toBe(true);
    expect("editComment" in adapter).toBe(false);
  });
});

describe("JiraAdapter fetch/list/claim", () => {
  it("fetch uses key = QUERY and maps labels", async () => {
    const { cli, calls } = makeJiraCli();
    const adapter = adapterFor(cli);
    const ticket = await adapter.fetch(REF);
    expect(ticket.ref).toEqual(REF);
    expect(ticket.title).toBe("Widgets rattle");
    expect(ticket.labels).toEqual(["factory:ready"]);
    expect(ticket.author).toBe("ada@example.com");
    expect(ticket.kind).toBe("feature");
    const list = calls.find((c) => c[2] === "list");
    expect(flag(list!, "-q")).toBe("key = DEMO-1");
    expect(list).toContain("--raw");
  });

  it("list pins the labels JQL including watermark", async () => {
    const { cli, calls } = makeJiraCli();
    const adapter = adapterFor(cli);
    const since = new Date("2026-09-01T00:00:00.000Z");
    const listed = await adapter.list({ label: "factory:ready", state: "open", updatedSince: since });
    expect(listed).toHaveLength(1);
    const q = flag(calls.find((c) => c[2] === "list")!, "-q");
    expect(q).toBe(
      'labels = "factory:ready" AND statusCategory != Done AND updated >= "2026-09-01T00:00:00.000Z"',
    );
  });

  it("acknowledge moves to In Progress and swaps labels", async () => {
    const { cli, calls } = makeJiraCli();
    const adapter = adapterFor(cli);
    await adapter.acknowledge(REF);
    expect(calls.some((c) => c[2] === "edit" && c.includes("--remove-label") && c.includes("factory:ready"))).toBe(true);
    expect(calls.some((c) => c[2] === "edit" && c.includes("--add-label") && c.includes("factory:in-progress"))).toBe(
      true,
    );
    const move = calls.find((c) => c[2] === "move");
    expect(move).toEqual(["jira", "issue", "move", "DEMO-1", "In Progress"]);
  });

  it("skips move when transitionOnClaim is false", async () => {
    const { cli, calls } = makeJiraCli();
    const adapter = adapterFor(cli, { transitionOnClaim: false });
    await adapter.acknowledge(REF);
    expect(calls.some((c) => c[2] === "move")).toBe(false);
  });
});

describe("JiraAdapter two-comment cadence", () => {
  it("posts claim + terminal only; stage-exit is a no-exec", async () => {
    const { cli, calls } = makeJiraCli();
    const adapter = adapterFor(cli);
    const claim = await adapter.comment(REF, "claimed", { idempotencyKey: "claim" });
    for (let i = 0; i < 5; i++) {
      const stage = await adapter.comment(REF, `stage ${i}`, { idempotencyKey: `stage-exit:${i}` });
      expect(stage).toBe(claim);
    }
    const terminal = await adapter.comment(REF, "done", { idempotencyKey: "terminal" });
    expect(terminal).toBeTruthy();
    const adds = calls.filter((c) => c[2] === "comment" && c[3] === "add");
    expect(adds).toHaveLength(2);
    expect(adds[0]).toContain("--body-file");
    expect(adds[0]).toContain("-");
  });

  it("posts a stage-exit only when cadence is disabled", async () => {
    const { cli, calls } = makeJiraCli();
    const adapter = adapterFor(cli, { commentMode: "all" });
    await adapter.comment(REF, "claimed", { idempotencyKey: "claim" });
    await adapter.comment(REF, "stage", { idempotencyKey: "stage-exit:1" });
    await adapter.comment(REF, "done", { idempotencyKey: "terminal" });
    const adds = calls.filter((c) => c[2] === "comment" && c[3] === "add");
    expect(adds).toHaveLength(3);
  });

  it("force:true posts a stage-exit even in cadence mode", async () => {
    const { cli, calls } = makeJiraCli();
    const adapter = adapterFor(cli);
    await adapter.comment(REF, "claimed", { idempotencyKey: "claim" });
    await adapter.comment(REF, "forced", { idempotencyKey: "stage-exit:force", force: true });
    const adds = calls.filter((c) => c[2] === "comment" && c[3] === "add");
    expect(adds).toHaveLength(2);
  });

  it("linkPR uses issue link remote KEY url PR", async () => {
    const { cli, calls } = makeJiraCli();
    const adapter = adapterFor(cli);
    await adapter.linkPR(REF, { repo: "acme/widgets", number: 9, url: "https://example/pr" });
    expect(calls.some((c) => c.join(" ") === "jira issue link remote DEMO-1 https://example/pr PR")).toBe(true);
  });
});

describe("JiraAdapter host-only", () => {
  it("does not import worker modules or mention AZURE_/JIRA_ tokens", async () => {
    const src = await readFile(fileURLToPath(new URL("../../../src/trackers/jira.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/from ["'][^"']*worker/);
    expect(src).not.toMatch(/AZURE_|JIRA_/);
  });

  it("worker env never carries JIRA_* or AZURE_* tokens", () => {
    const env = buildWorkerEnv(
      { PATH: "/usr/bin", HOME: "/tmp", JIRA_API_TOKEN: "jira-secret", AZURE_DEVOPS_EXT_PAT: "az-secret" },
      makeWorkerRequest(),
    );
    expect(env).not.toHaveProperty("JIRA_API_TOKEN");
    expect(env).not.toHaveProperty("AZURE_DEVOPS_EXT_PAT");
  });
});
