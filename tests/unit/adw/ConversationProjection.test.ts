import { describe, it, expect, beforeEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendProjection,
  readRecentEntries,
  formatPrelude,
  projectionPath,
} from "../../../src/adw/ConversationProjection.js";
import type { EngteamEvent } from "../../../src/types.js";

let runDir: string;

beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), "projection-"));
});

function evt(p: Partial<EngteamEvent>): EngteamEvent {
  return {
    ts: "2026-05-08T00:00:00.000Z",
    runId: "run-1",
    category: "lifecycle",
    type: "step.start",
    payload: {},
    ...p,
  } as EngteamEvent;
}

describe("ConversationProjection — spec §9.1 schema", () => {
  it("appends a kind-typed event with from/to/text", async () => {
    await appendProjection(runDir, evt({
      type: "request",
      category: "message",
      payload: { from: "user", to: "orchestrator", text: "consult on X" },
    }));
    const entries = await readRecentEntries(runDir, 50);
    expect(entries).toHaveLength(1);
    const [e] = entries;
    expect(e.from).toBe("user");
    expect(e.to).toBe("orchestrator");
    expect(e.kind).toBe("request");
    expect(e.text).toBe("consult on X");
  });

  it("maps verdict.emit to kind=verdict with artifact ref", async () => {
    await appendProjection(runDir, evt({
      category: "verdict",
      type: "emit",
      step: "position-eng",
      agentName: "engineering-lead",
      payload: { verdict: "PASS", artifacts: ["positions/engineering-lead.md"] },
    }));
    const [e] = await readRecentEntries(runDir, 10);
    expect(e.from).toBe("engineering-lead");
    expect(e.to).toBe("*");
    expect(e.kind).toBe("verdict");
    expect(e.text).toContain("PASS");
    expect(e.text).toContain("position-eng");
    expect(e.ref).toBe("positions/engineering-lead.md");
  });

  it("maps category=verdict type=verify into kind=correction", async () => {
    await appendProjection(runDir, evt({
      category: "verdict",
      type: "verify",
      agentName: "verifier",
      step: "build",
      summary: "verifier FAIL on build",
      payload: { verdict: "FAIL", issues: ["compile error"], report: "/runs/r1/verify-report.md" },
    }));
    const [e] = await readRecentEntries(runDir, 10);
    expect(e.kind).toBe("correction");
    expect(e.from).toBe("verifier");
    expect(e.text).toContain("FAIL");
    expect(e.ref).toBe("/runs/r1/verify-report.md");
  });

  it("maps message.sent to dispatch with from/to", async () => {
    await appendProjection(runDir, evt({
      category: "message",
      type: "sent",
      payload: { from: "orchestrator", to: "engineering-lead", summary: "go" },
    }));
    const [e] = await readRecentEntries(runDir, 10);
    expect(e.kind).toBe("dispatch");
    expect(e.from).toBe("orchestrator");
    expect(e.to).toBe("engineering-lead");
    expect(e.text).toBe("go");
  });

  it("projects only run-level lifecycle, skips step-level", async () => {
    await appendProjection(runDir, evt({
      category: "lifecycle",
      type: "step.start",
      summary: "step started",
      payload: {},
    }));
    await appendProjection(runDir, evt({
      category: "lifecycle",
      type: "run.start",
      summary: "run started: do thing",
    }));
    await appendProjection(runDir, evt({
      category: "lifecycle",
      type: "run.cancelled",
      summary: "Run abc cancelled",
    }));
    const entries = await readRecentEntries(runDir, 10);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("note");
    expect(entries[0].text).toContain("run started");
    expect(entries[1].text).toContain("cancelled");
    for (const e of entries) {
      expect(e.from).toBe("system");
      expect(e.to).toBe("*");
    }
  });

  it("clips text at 500 chars with ellipsis", async () => {
    const huge = "x".repeat(800);
    await appendProjection(runDir, evt({
      type: "note",
      category: "message",
      payload: { from: "system", to: "*", text: huge },
    }));
    const [e] = await readRecentEntries(runDir, 10);
    expect(e.text.length).toBeLessThanOrEqual(500);
    expect(e.text.endsWith("…")).toBe(true);
  });

  it("skips malformed legacy lines instead of throwing", async () => {
    // Write one legacy-shaped line + one current-shaped line.
    await mkdir(runDir, { recursive: true });
    const legacy = JSON.stringify({ ts: "x", agent: "a", kind: "x", payload: {} }) + "\n";
    await writeFile(projectionPath(runDir), legacy);
    await appendProjection(runDir, evt({
      type: "note",
      category: "message",
      payload: { from: "system", to: "*", text: "ok" },
    }));
    const entries = await readRecentEntries(runDir, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("ok");
  });

  it("formatPrelude renders [kind] from → to: text [ref]", async () => {
    const out = formatPrelude([
      { ts: "t", from: "a", to: "b", kind: "dispatch", text: "hi" },
      { ts: "t", from: "v", to: "*", kind: "verdict", text: "PASS on s", ref: "out.md" },
    ]);
    expect(out).toContain("[dispatch] a → b: hi");
    expect(out).toContain("[verdict] v → *: PASS on s (out.md)");
  });
});
