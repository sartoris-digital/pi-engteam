import { describe, it, expect } from "vitest";
import { AzureDevOpsAdapter, ticketLinkLine } from "../../../src/trackers/azure-devops.js";
import { createFakeCli, type HostCliResult } from "../../../src/trackers/host-cli.js";

const REF = { tracker: "azure-devops", id: "42" } as const;
const API = "7.1-preview.4";

function json(value: unknown, code = 0): HostCliResult {
  return { stdout: `${JSON.stringify(value)}\n`, stderr: "", code };
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v !== undefined && !v.startsWith("-") ? v : undefined;
}

function makeWriteCli(): {
  calls: string[][];
  comments: Array<{ id: number; text: string }>;
  adapter: AzureDevOpsAdapter;
} {
  const calls: string[][] = [];
  const comments: Array<{ id: number; text: string }> = [];
  let nextId = 7;
  const cli = createFakeCli((argv) => {
    calls.push([...argv]);
    if (argv[1] === "rest") {
      const method = (flag(argv, "--method") ?? "GET").toUpperCase();
      const uri = flag(argv, "--uri") ?? "";
      if (method === "GET" && /comments/.test(uri) && !/comments\/\d+/.test(uri)) {
        return json({ comments, count: comments.length });
      }
      if (method === "POST" && /comments/.test(uri)) {
        const body = JSON.parse(flag(argv, "--body") ?? "{}") as { text?: string };
        const row = { id: nextId, text: body.text ?? "" };
        nextId += 1;
        comments.push(row);
        return json(row);
      }
      if (method === "PATCH" && /comments\/(\d+)/.test(uri)) {
        const id = Number(/comments\/(\d+)/.exec(uri)?.[1]);
        const body = JSON.parse(flag(argv, "--body") ?? "{}") as { text?: string };
        const found = comments.find((c) => c.id === id);
        if (found) found.text = body.text ?? found.text;
        return json({ id, text: body.text ?? "" });
      }
    }
    if (argv[1] === "repos" && argv[2] === "pr" && argv[3] === "create") {
      return json({
        pullRequestId: 99,
        url: "https://dev.azure.com/contoso/widgets/_git/widgets/pullrequest/99",
      });
    }
    if (argv[1] === "repos" && argv[2] === "pr" && argv[3] === "work-item") {
      return json({ pullRequestId: Number(flag(argv, "--id")), workItemRefs: [{ id: "42" }] });
    }
    return { stdout: "", stderr: `unhandled ${argv.join(" ")}`, code: 1 };
  });
  const adapter = new AzureDevOpsAdapter({
    org: "contoso",
    project: "widgets",
    allowedAuthors: ["ada@contoso"],
    cli,
  });
  return { calls, comments, adapter };
}

describe("AzureDevOpsAdapter comments REST", () => {
  it("POSTs a comment and PATCHes it in place", async () => {
    const { adapter, calls, comments } = makeWriteCli();
    const id = await adapter.comment(REF, "claimed", { idempotencyKey: "claim:42" });
    expect(id).toBe("7");
    const post = calls.find((c) => c[1] === "rest" && flag(c, "--method") === "POST");
    expect(post).toBeDefined();
    expect(flag(post!, "--uri")).toMatch(
      /\/contoso\/widgets\/_apis\/wit\/workItems\/42\/comments\?api-version=7\.1-preview\.4$/,
    );
    expect(flag(post!, "--uri")).toContain(API);
    expect(JSON.parse(flag(post!, "--body") ?? "{}").text).toMatch(/claimed/);

    await adapter.editComment(REF, "7", "updated sticky");
    const patch = calls.find((c) => c[1] === "rest" && flag(c, "--method") === "PATCH");
    expect(flag(patch!, "--uri")).toMatch(/\/comments\/7\?api-version=7\.1-preview\.4$/);
    expect(comments[0]?.text).toBe("updated sticky");
  });

  it("does not POST twice for the same idempotencyKey", async () => {
    const { adapter, calls } = makeWriteCli();
    const first = await adapter.comment(REF, "hello", { idempotencyKey: "k1" });
    const second = await adapter.comment(REF, "hello again", { idempotencyKey: "k1" });
    expect(first).toBe("7");
    expect(second).toBe(first);
    const posts = calls.filter((c) => c[1] === "rest" && flag(c, "--method") === "POST");
    expect(posts).toHaveLength(1);
  });
});

describe("AzureDevOpsAdapter PR link", () => {
  it("createPr returns url/number and linkPR adds the work item", async () => {
    const { adapter, calls } = makeWriteCli();
    const pr = await adapter.createPr({
      source: "factory/ado-42-widgets",
      target: "main",
      title: "chore: widgets (AB#42)",
      body: "AB#42\n",
      draft: true,
    });
    expect(pr).toEqual({
      number: "99",
      url: "https://dev.azure.com/contoso/widgets/_git/widgets/pullrequest/99",
    });
    const create = calls.find((c) => c[1] === "repos" && c[3] === "create");
    expect(create).toBeDefined();
    expect(create).toContain("--draft");

    await adapter.linkPR(REF, { repo: "contoso/widgets", number: 99, url: pr.url });
    const link = calls.find((c) => c.includes("work-item") && c.includes("add"));
    expect(flag(link!, "--id")).toBe("99");
    expect(flag(link!, "--work-items")).toBe("42");
  });

  it("ticketLinkLine is AB#n", () => {
    expect(ticketLinkLine(REF)).toBe("AB#42");
    expect(ticketLinkLine({ tracker: "azure-devops", id: "contoso/widgets#42" })).toBe("AB#42");
  });
});
