import { matchesKey } from "@mariozechner/pi-tui";
import type { Component, TUI } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

/**
 * Yes/No overlay for operator approval of a Layer-C destructive op in the
 * controller session (where the RequestApproval tool is unavailable). Approval
 * requires an explicit "y" — Enter/n/Esc all deny, so a stray keypress can
 * never authorize a destructive command.
 */
export class ConfirmInput implements Component {
  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly title: string,
    private readonly detail: string,
    private readonly done: (result: { approved: boolean }) => void,
  ) {}

  handleInput(data: string): void {
    if (data === "y" || data === "Y") { this.done({ approved: true }); return; }
    if (
      data === "n" || data === "N" ||
      matchesKey(data, "enter") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")
    ) {
      this.done({ approved: false });
      return;
    }
    // ignore any other key (no decision yet)
  }

  render(_width: number): string[] {
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.title));
    lines.push("");
    for (const dl of this.detail.split("\n")) lines.push(this.theme.fg("muted", dl));
    lines.push("");
    lines.push(this.theme.fg("error", "y = APPROVE destructive op   ·   Enter / n / Esc = deny"));
    return lines;
  }

  invalidate(): void {
    // no child components; full re-render each time
  }
}

type CustomUi = {
  custom?: <T>(
    factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
    options?: any,
  ) => Promise<T>;
};

/**
 * Returns true ONLY when a human operator explicitly approves via the overlay.
 * Returns false (caller should block as normal) in every other case:
 *  - subprocess agent context (PI_ENGINEERING_RUN_ID set) → use RequestApproval tool path
 *  - no interactive TUI (ctx.ui.custom unavailable) → /approve command fallback (Phase 2)
 *  - operator denies / cancels
 */
export async function inlineOperatorApproval(ctx: any, opLabel: string, detail: string): Promise<boolean> {
  if (process.env["PI_ENGINEERING_RUN_ID"]) return false; // subprocess → tool path, never inline
  const customUi = (ctx?.ui as CustomUi | undefined)?.custom;
  if (typeof customUi !== "function") return false;        // non-TUI controller → Phase 2 /approve
  const title = `⚠ Layer C — ${opLabel} needs operator approval (no RequestApproval tool here)`;
  const result = await customUi<{ approved: boolean }>(
    (tui: any, theme: any, _kb: any, done: (r: { approved: boolean }) => void) =>
      new ConfirmInput(tui, theme, title, detail, done),
    { overlay: true, overlayOptions: { width: "70%", maxHeight: "40%", anchor: "top-center", offsetY: 2 } },
  );
  return result?.approved === true;
}
