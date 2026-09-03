import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AzureDevOpsAdapter, ticketLinkLine } from "../../../src/trackers/azure-devops.js";
import { createFakeCli, type HostCli, type HostCliResult } from "../../../src/trackers/host-cli.js";
import { buildWorkerEnv } from "../../../src/runtime/env.js";
import { makeWorkerRequest } from "../../helpers/worker-request.js";

const REF = { tracker: "azure-devops", id: "42" } as const;
const ORG = "contoso";
const PROJECT = "widgets";

interface AdoItem {
  id: number;
  fields: Record<string, unknown>;
}

function json(value: unknown, code = 0): HostCliResult {
  return { stdout: `${JSON.stringify(value)}\n`, stderr: "", code };
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v !== undefined && !v.startsWith("-") ? v : undefined;
}

function sampleItem(tags = "factory:ready; other-tag"): AdoItem {
  return {
    id: 42,
    fields: {
      "System.Id": 42,
      "System.Title": "Widgets rattle",
      "System.Description": "They rattle when dropped.",
      "System.Tags": tags,
      "System.State": "New",
      "System.CreatedBy": { uniqueName: "ada@contoso", displayName: "Ada" },
      "System.ChangedDate": "2026-09-01T00:00:00.000Z",
      "System.WorkItemType": "User Story",
    },
  };
}

function makeAdoCli(item: AdoItem = sampleItem()): { cli: HostCli; calls: string[][]; item: AdoItem } {
  const calls: string[][] = [];
  const cli = createFakeCli((argv) => {
    calls.push([...argv]);
    if (argv[0] === "az" && argv[1] === "account" && argv[2] === "show") {
      return json({ id: "sub", name: "Test" });
    }
    if (argv[0] === "az" && argv[1] === "devops" && argv[2] === "configure") {
      return json({ organization: `https://dev.azure.com/${ORG}`, project: PROJECT });
    }
    if (argv[0] === "az" && argv[1] === "boards" && argv[2] === "query") {
      return json({ workItems: [{ id: item.id }] });
    }
    if (argv[0] === "az" && argv[1] === "boards" && argv[2] === "work-item" && argv[3] === "show") {
      return json(item);
    }
    if (argv[0] === "az" && argv[1] === "boards" && argv[2] === "work-item" && argv[3] === "update") {
      const fields = flag(argv, "--fields");
      if (fields?.startsWith("System.Tags=")) {
        item.fields["System.Tags"] = fields.slice("System.Tags=".length);
      }
      const state = flag(argv, "--state");
      if (state !== undefined) item.fields["System.State"] = state;
      return json(item);
    }
    return { stdout: "", stderr: `unhandled ${argv.join(" ")}`, code: 1 };
  });
  return { cli, calls, item };
}

function adapterFor(cli: HostCli, extra?: { transitionOnClaim?: boolean; allowedAuthors?: string[] }): AzureDevOpsAdapter {
  return new AzureDevOpsAdapter({
    org: ORG,
    project: PROJECT,
    allowedAuthors: extra?.allowedAuthors ?? ["ada@contoso"],
    cli,
    ...(extra?.transitionOnClaim === undefined ? {} : { transitionOnClaim: extra.transitionOnClaim }),
  });
}

describe("AzureDevOpsAdapter.parseRef", () => {
  const { cli } = makeAdoCli();
  const adapter = adapterFor(cli);

  it("accepts AB#42, ado:org/project#42, and bound #42", () => {
    expect(adapter.parseRef("AB#42")).toEqual(REF);
    expect(adapter.parseRef("ado:contoso/widgets#42")).toEqual({
      tracker: "azure-devops",
      id: "contoso/widgets#42",
    });
    expect(adapter.parseRef("#42")).toEqual(REF);
  });

  it("rejects Jira keys and local ulids", () => {
    expect(adapter.parseRef("DEMO-1")).toBeNull();
    expect(adapter.parseRef("local-01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeNull();
  });

  it("round-trips AB#42 through ticketLinkLine", () => {
    const ref = adapter.parseRef("AB#42");
    expect(ref).not.toBeNull();
    expect(ticketLinkLine(ref!)).toBe("AB#42");
  });
});

describe("AzureDevOpsAdapter constructor", () => {
  it("throws when allowedAuthors is empty", () => {
    const { cli } = makeAdoCli();
    expect(() => adapterFor(cli, { allowedAuthors: [] })).toThrow(/allowedAuthors/);
  });

  it("sets id and capabilities including transition, linkPR, nativeQuery, editComment", () => {
    const { cli } = makeAdoCli();
    const adapter = adapterFor(cli);
    expect(adapter.id).toBe("azure-devops");
    expect([...adapter.capabilities].sort()).toEqual(["editComment", "linkPR", "nativeQuery", "transition"].sort());
  });
});

describe("AzureDevOpsAdapter fetch/list/tags", () => {
  it("fetch maps System.Tags onto labels and sanitizes the body", async () => {
    const { cli } = makeAdoCli(sampleItem("factory:ready; other-tag"));
    const adapter = adapterFor(cli);
    const ticket = await adapter.fetch(REF);
    expect(ticket.ref).toEqual(REF);
    expect(ticket.title).toBe("Widgets rattle");
    expect(ticket.labels).toEqual(["factory:ready", "other-tag"]);
    expect(ticket.author).toBe("ada@contoso");
    expect(ticket.state).toBe("New");
    expect(ticket.kind).toBe("feature");
  });

  it("list pins the WIQL string then shows each id", async () => {
    const { cli, calls } = makeAdoCli();
    const adapter = adapterFor(cli);
    const since = new Date("2026-09-01T00:00:00.000Z");
    const listed = await adapter.list({ label: "factory:ready", state: "open", updatedSince: since });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.ref).toEqual(REF);
    const query = calls.find((c) => c[1] === "boards" && c[2] === "query");
    expect(query).toBeDefined();
    expect(flag(query!, "--wiql")).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.Tags] CONTAINS 'factory:ready' AND [System.State] NOT IN ('Closed','Removed') AND [System.ChangedDate] >= '2026-09-01T00:00:00.000Z'",
    );
    expect(calls.some((c) => c[2] === "work-item" && c[3] === "show" && c.includes("42"))).toBe(true);
  });

  it("addLabel/removeLabel RMW System.Tags and keep unrelated tags", async () => {
    const { cli, calls, item } = makeAdoCli(sampleItem("factory:ready; other-tag"));
    const adapter = adapterFor(cli);
    await adapter.addLabel(REF, "factory:in-progress");
    expect(String(item.fields["System.Tags"])).toMatch(/other-tag/);
    expect(String(item.fields["System.Tags"])).toMatch(/factory:in-progress/);
    await adapter.removeLabel(REF, "factory:ready");
    expect(String(item.fields["System.Tags"])).not.toMatch(/factory:ready/);
    expect(String(item.fields["System.Tags"])).toMatch(/other-tag/);
    const updates = calls.filter((c) => c[3] === "update");
    expect(updates.length).toBeGreaterThanOrEqual(2);
    for (const u of updates) {
      const fields = flag(u, "--fields") ?? "";
      expect(fields).toMatch(/^System\.Tags=/);
      expect(fields).toMatch(/other-tag/);
    }
  });

  it("acknowledge swaps ready→in-progress in one RMW and transitions on claim", async () => {
    const { cli, calls, item } = makeAdoCli(sampleItem("factory:ready; other-tag"));
    const adapter = adapterFor(cli);
    await adapter.acknowledge(REF);
    expect(String(item.fields["System.Tags"])).toMatch(/factory:in-progress/);
    expect(String(item.fields["System.Tags"])).not.toMatch(/factory:ready/);
    expect(String(item.fields["System.Tags"])).toMatch(/other-tag/);
    const tagUpdates = calls.filter((c) => c[3] === "update" && (flag(c, "--fields") ?? "").startsWith("System.Tags="));
    expect(tagUpdates).toHaveLength(1);
    expect(calls.some((c) => c[3] === "update" && flag(c, "--state") === "Active")).toBe(true);
  });

  it("skips transition when transitionOnClaim is false", async () => {
    const { cli, calls } = makeAdoCli();
    const adapter = adapterFor(cli, { transitionOnClaim: false });
    await adapter.acknowledge(REF);
    expect(calls.some((c) => flag(c, "--state") !== undefined)).toBe(false);
  });
});

describe("AzureDevOpsAdapter host-only", () => {
  it("does not import worker modules or mention AZURE_/JIRA_ tokens", async () => {
    const src = await readFile(fileURLToPath(new URL("../../../src/trackers/azure-devops.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/from ["'][^"']*worker/);
    expect(src).not.toMatch(/AZURE_|JIRA_/);
  });

  it("worker env never carries AZURE_* or JIRA_* tokens", () => {
    const env = buildWorkerEnv(
      {
        PATH: "/usr/bin",
        HOME: "/tmp",
        AZURE_DEVOPS_EXT_PAT: "az-secret",
        AZURE_CLIENT_SECRET: "az-client",
        JIRA_API_TOKEN: "jira-secret",
      },
      makeWorkerRequest(),
    );
    expect(env).not.toHaveProperty("AZURE_DEVOPS_EXT_PAT");
    expect(env).not.toHaveProperty("AZURE_CLIENT_SECRET");
    expect(env).not.toHaveProperty("JIRA_API_TOKEN");
    expect(JSON.stringify(env)).not.toMatch(/az-secret|az-client|jira-secret/);
  });
});
