import type { SteerPacket } from "./packet.js";

export const STEER_ACTIONS = ["approve", "steer", "replan", "edit-approve", "drop"] as const;
export type SteerAction = (typeof STEER_ACTIONS)[number];

/**
 * In-memory steer decision handed to Engine.resumeRun and returned by askSteer.
 * `pending` means no decision yet (the run stays waiting_user).
 * `waive` is collected by `/factory approve --waive <ruleId>` (Task 9.11), not the TUI.
 */
export interface SteerDecision {
  action: SteerAction | "pending";
  notes?: string;
  waive?: string[];
}

export const STEER_MENU: ReadonlyArray<{ label: string; action: SteerAction }> = [
  { label: "Approve", action: "approve" },
  { label: "Steer with notes", action: "steer" },
  { label: "Re-plan with notes", action: "replan" },
  { label: "Edit in worktree then approve", action: "edit-approve" },
  { label: "Drop", action: "drop" },
];

/** Structural subset of Pi's ExtensionCommandContext used by the dialog (tests pass a fake). */
export interface SteerUiContext {
  hasUI: boolean;
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
  };
}

export function isSteerAction(value: unknown): value is SteerAction {
  return typeof value === "string" && (STEER_ACTIONS as readonly string[]).includes(value);
}

const NOTES_TITLE: Record<"steer" | "replan", string> = {
  steer: "Steering notes for the implementer (recorded as data, not instructions):",
  replan: "Re-plan notes for the planner (recorded as data, not instructions):",
};

/**
 * Presents the steer packet as a select over the five spec actions (§4.10).
 * Without a UI (print/JSON mode) the decision is "pending" and the run stays paused.
 * The caller persists a non-pending decision with writeSteerDecision (stage.ts)
 * before calling engine.resumeRun — this module writes nothing.
 */
export async function askSteer(ctx: SteerUiContext, packet: SteerPacket): Promise<SteerDecision> {
  if (!ctx.hasUI) return { action: "pending" };

  const c = packet.json.classification;
  const title = `Steer · ${packet.json.ticket.ref} · ${c.kind}/${c.tier} · packet: ${packet.markdownPath}`;
  const label = await ctx.ui.select(
    title,
    STEER_MENU.map((m) => m.label),
  );
  const entry = STEER_MENU.find((m) => m.label === label);
  if (entry === undefined) return { action: "pending" };

  if (entry.action === "steer" || entry.action === "replan") {
    const raw = await ctx.ui.editor(NOTES_TITLE[entry.action], "");
    if (raw === undefined) return { action: "pending" };
    const notes = raw.trim();
    if (notes.length === 0) return entry.action === "steer" ? { action: "approve" } : { action: "replan" };
    return { action: entry.action, notes };
  }
  return { action: entry.action };
}
