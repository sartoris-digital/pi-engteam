import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatedMarker as homeMarker } from "../../../src/home.js";
import {
  ensureGeneratedMarker,
  generatedMarker,
  readJsonArtifact,
  writeTextArtifact,
  writeTicketMarkdown,
} from "../../../src/controller/artifacts.js";

let runDir: string;
beforeEach(async () => {
  runDir = join(await mkdtemp(join(tmpdir(), "pi-sdlc-art-")), "runs", "run-1");
  await mkdir(runDir, { recursive: true });
});
afterEach(async () => {
  await rm(join(runDir, "..", ".."), { recursive: true, force: true });
});

describe("artifacts", () => {
  it("re-exports the home.ts marker and stamps it on writeTextArtifact", async () => {
    expect(generatedMarker).toBe(homeMarker);
    const path = await writeTextArtifact(runDir, "plan.md", "## Goal\nhello\n");
    expect(path).toBe(join(runDir, "plan.md"));
    const text = await readFile(path, "utf8");
    expect(text.split("\n")[0]).toBe(generatedMarker("run-1"));
    expect(text).toContain("## Goal");
  });

  it("ensureGeneratedMarker is idempotent and repairs a stub runDirFiles write", async () => {
    const path = join(runDir, "plan.md");
    await writeFile(path, "## Goal\n");
    await ensureGeneratedMarker(path, "run-1");
    await ensureGeneratedMarker(path, "run-1");
    const text = await readFile(path, "utf8");
    expect(text.startsWith(generatedMarker("run-1") + "\n")).toBe(true);
    expect(text.split(generatedMarker("run-1")).length).toBe(2);
  });

  it("writeTicketMarkdown fences the body and readJsonArtifact round-trips", async () => {
    const ticket = await writeTicketMarkdown(runDir, "Do the thing", "nonce-1");
    const body = await readFile(ticket, "utf8");
    expect(body.split("\n")[0]).toBe(generatedMarker("run-1"));
    expect(body).toContain("Do the thing");
    expect(body).toContain("nonce-1");
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ ok: true }));
    expect(await readJsonArtifact<{ ok: boolean }>(join(runDir, "brief.json"))).toEqual({ ok: true });
  });
});
