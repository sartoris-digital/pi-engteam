import { describe, it, expect } from "vitest";
import { askSteer, isSteerAction, STEER_ACTIONS, STEER_MENU, type SteerUiContext } from "../../../src/steer/dialog.js";
import type { SteerPacket } from "../../../src/steer/packet.js";

function packet(): SteerPacket {
  return {
    markdown: "",
    markdownPath: "/runs/run-0001/steer-packet.md",
    jsonPath: "/runs/run-0001/steer-packet.json",
    json: {
      generated: "<!-- pi-sdlc-factory generated · run run-0001 · do not commit -->",
      runId: "run-0001",
      composedAt: "2026-09-02T10:00:00.000Z",
      ticket: { tracker: "local", ref: "local-01ARZ3NDEKTSV4RRFFQ69G5FAV", title: "Rename README heading" },
      classification: { kind: "chore", tier: "low", lane: "chore", confidence: null },
      acceptanceCriteria: [],
      plan: { present: false, path: null, summary: "" },
      redTests: [],
      filesToTouch: [],
      budget: {
        fixRounds: 2,
        maxWallSeconds: 1800,
        maxCostUsd: 5,
        maxIterations: 9,
        wallSecondsUsed: 0,
        costUsd: 0,
        steering: "always",
      },
      openQuestions: [],
    },
  };
}

function fakeCtx(opts: { hasUI?: boolean; select?: string; editor?: string }): SteerUiContext & { calls: string[] } {
  const calls: string[] = [];
  return {
    hasUI: opts.hasUI ?? true,
    calls,
    ui: {
      async select(title: string, options: string[]) {
        calls.push(`select:${title}:${options.join("|")}`);
        return opts.select;
      },
      async editor(title: string, prefill?: string) {
        calls.push(`editor:${title}:${prefill ?? ""}`);
        return opts.editor;
      },
    },
  };
}

describe("steer dialog", () => {
  it("offers exactly the five spec actions in order", () => {
    expect(STEER_MENU.map((m) => m.label)).toEqual([
      "Approve",
      "Steer with notes",
      "Re-plan with notes",
      "Edit in worktree then approve",
      "Drop",
    ]);
    expect(STEER_MENU.map((m) => m.action)).toEqual([...STEER_ACTIONS]);
    expect(isSteerAction("replan")).toBe(true);
    expect(isSteerAction("pending")).toBe(false);
    expect(isSteerAction(null)).toBe(false);
  });

  it("returns pending without touching the UI when there is no UI", async () => {
    const ctx = fakeCtx({ hasUI: false, select: "Approve" });
    expect(await askSteer(ctx, packet())).toEqual({ action: "pending" });
    expect(ctx.calls).toEqual([]);
  });

  it("returns pending when the select is cancelled", async () => {
    const ctx = fakeCtx({ select: undefined });
    expect(await askSteer(ctx, packet())).toEqual({ action: "pending" });
    expect(ctx.calls).toHaveLength(1);
  });

  it("shows the ticket ref, kind/tier and packet path in the select title", async () => {
    const ctx = fakeCtx({ select: "Approve" });
    await askSteer(ctx, packet());
    expect(ctx.calls[0]).toBe(
      "select:Steer · local-01ARZ3NDEKTSV4RRFFQ69G5FAV · chore/low · packet: /runs/run-0001/steer-packet.md:Approve|Steer with notes|Re-plan with notes|Edit in worktree then approve|Drop",
    );
  });

  it.each([
    ["Approve", "approve"],
    ["Edit in worktree then approve", "edit-approve"],
    ["Drop", "drop"],
  ] as const)("%s → %s without opening the editor", async (label, action) => {
    const ctx = fakeCtx({ select: label, editor: "should not be read" });
    expect(await askSteer(ctx, packet())).toEqual({ action });
    expect(ctx.calls.filter((c) => c.startsWith("editor:"))).toEqual([]);
  });

  it("Steer with notes collects trimmed notes from the editor", async () => {
    const ctx = fakeCtx({ select: "Steer with notes", editor: "  Keep the badge row.\n " });
    expect(await askSteer(ctx, packet())).toEqual({ action: "steer", notes: "Keep the badge row." });
    expect(ctx.calls[1]).toBe("editor:Steering notes for the implementer (recorded as data, not instructions)::");
  });

  it("Steer with notes falls back to approve when the notes are empty", async () => {
    const ctx = fakeCtx({ select: "Steer with notes", editor: "   " });
    expect(await askSteer(ctx, packet())).toEqual({ action: "approve" });
  });

  it("Steer with notes returns pending when the editor is cancelled", async () => {
    const ctx = fakeCtx({ select: "Steer with notes", editor: undefined });
    expect(await askSteer(ctx, packet())).toEqual({ action: "pending" });
  });

  it("Re-plan with notes carries the notes, or none when the editor is empty", async () => {
    expect(await askSteer(fakeCtx({ select: "Re-plan with notes", editor: "Split docs step" }), packet())).toEqual({
      action: "replan",
      notes: "Split docs step",
    });
    expect(await askSteer(fakeCtx({ select: "Re-plan with notes", editor: "" }), packet())).toEqual({ action: "replan" });
    expect(await askSteer(fakeCtx({ select: "Re-plan with notes", editor: undefined }), packet())).toEqual({
      action: "pending",
    });
  });
});
