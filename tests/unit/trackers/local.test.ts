import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAdapter, deriveTitle, localTicketsDir } from "../../../src/trackers/local.js";
import { createUlidGenerator } from "../../../src/trackers/ulid.js";

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "sdlc-local-"));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

describe("LocalAdapter", () => {
  it("mints local-<ulid> ids and round-trips through parseRef and fetch", async () => {
    const adapter = new LocalAdapter(runsDir, { now: () => new Date("2026-09-02T09:00:00Z") });
    const ticket = await adapter.createFromTask(
      "Rename README heading\n\nMake the title match the package name.",
      { kind: "chore" },
    );
    expect(adapter.id).toBe("local");
    expect(ticket.ref.tracker).toBe("local");
    expect(ticket.ref.id).toMatch(/^local-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ticket.title).toBe("Rename README heading");
    expect(ticket.body).toBe("Rename README heading\n\nMake the title match the package name.");
    expect(ticket.kind).toBe("chore");
    expect(ticket.author).toBe("operator");
    expect(ticket.labels).toEqual([]);
    expect(adapter.parseRef(ticket.ref.id)).toEqual(ticket.ref);
    expect(adapter.parseRef(`  ${ticket.ref.id}\n`)).toEqual(ticket.ref);
    expect(await adapter.fetch(ticket.ref)).toEqual(ticket);
  });

  it("stores each ticket as 0600 JSON under runs/_factory/local-tickets/<id>.json", async () => {
    const adapter = new LocalAdapter(runsDir, { now: () => new Date("2026-09-02T09:00:00Z") });
    const ticket = await adapter.createFromTask("Bump copyright year");
    const path = join(localTicketsDir(runsDir), `${ticket.ref.id}.json`);
    expect(path).toBe(join(runsDir, "_factory", "local-tickets", `${ticket.ref.id}.json`));
    const record = JSON.parse(await readFile(path, "utf8"));
    expect(record).toEqual({
      schemaVersion: 1,
      ticket,
      status: "queued",
      createdAt: "2026-09-02T09:00:00.000Z",
      updatedAt: "2026-09-02T09:00:00.000Z",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("lists tickets in creation order and filters by status", async () => {
    const adapter = new LocalAdapter(runsDir, { ulid: createUlidGenerator(() => 1_756_800_000_000) });
    const a = await adapter.createFromTask("first");
    const b = await adapter.createFromTask("second");
    const c = await adapter.createFromTask("third");
    await adapter.setStatus(b.ref, "running");

    const all = await adapter.list();
    expect(all.map((r) => r.ticket.ref.id)).toEqual([a.ref.id, b.ref.id, c.ref.id]);
    expect(all.map((r) => r.status)).toEqual(["queued", "running", "queued"]);

    const queued = await adapter.list({ status: "queued" });
    expect(queued.map((r) => r.ticket.body)).toEqual(["first", "third"]);
  });

  it("returns an empty list before any ticket exists", async () => {
    expect(await new LocalAdapter(runsDir).list()).toEqual([]);
  });

  it("rejects refs from other trackers and unknown ids", async () => {
    const adapter = new LocalAdapter(runsDir);
    expect(adapter.parseRef("github:acme/widgets#1")).toBeNull();
    expect(adapter.parseRef("local-short")).toBeNull();
    expect(adapter.parseRef("local-" + "0".repeat(25) + "I")).toBeNull();
    await expect(adapter.fetch({ tracker: "local", id: "local-" + "0".repeat(26) })).rejects.toThrow(
      /local ticket not found: local-0{26}/,
    );
    await expect(adapter.fetch({ tracker: "github", id: "acme/widgets#1" })).rejects.toThrow(/not a local ref/);
  });

  it("refuses an empty task", async () => {
    await expect(new LocalAdapter(runsDir).createFromTask("  \n\t ")).rejects.toThrow(/empty/);
  });

  it("comment is a no-op that returns null", async () => {
    const adapter = new LocalAdapter(runsDir);
    const ticket = await adapter.createFromTask("anything");
    expect(await adapter.comment(ticket.ref, "hello", { idempotencyKey: "k" })).toBeNull();
  });

  it("honours an explicit title and author", async () => {
    const adapter = new LocalAdapter(runsDir, { author: "nick" });
    const ticket = await adapter.createFromTask("body text", { title: "Custom title" });
    expect(ticket.title).toBe("Custom title");
    expect(ticket.author).toBe("nick");
    expect(ticket.kind).toBeUndefined();
  });
});

describe("deriveTitle", () => {
  it("takes the first non-empty line, strips heading marks and caps at 72 chars", () => {
    expect(deriveTitle("\n\n## Fix the thing\nmore")).toBe("Fix the thing");
    const long = "x".repeat(100);
    expect(deriveTitle(long)).toBe("x".repeat(69) + "...");
    expect(deriveTitle(long)).toHaveLength(72);
  });
});
