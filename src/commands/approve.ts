// src/commands/approve.ts
//
// Phase 2: /approve + /deny command fallback for controller Judge approval.
//
// When the inline ConfirmInput overlay (Phase 1) is unavailable — headless
// controller, CI environment, or pre-authorization — the operator can:
//   /approve   → inspect the pending op, confirm, and mint a short-TTL token
//   /deny      → clear the pending record without minting a token
//
// IMPORTANT: /approve is a human-typed slash command. The model cannot invoke
// it. This is the human-in-the-loop authority for the headless path.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  readPendingControllerApproval,
  mintControllerToken,
  clearPendingControllerApproval,
} from "../safety/controllerApproval.js";
import { ConfirmInput } from "../ui/ConfirmInput.js";

export function registerApproveCommands(pi: ExtensionAPI, runsDir: string): void {
  // /approve — inspect the pending blocked op and, if the operator confirms,
  // mint a controller token so the next tool-call attempt is allowed.
  pi.registerCommand("approve", {
    description:
      "Approve a pending blocked Layer-C op (pre-authorize for headless/non-TUI sessions). Mints a short-TTL token in the _controller context. Usage: /approve",
    handler: async (_args: string, ctx) => {
      try {
        const pending = await readPendingControllerApproval(runsDir);
        if (!pending) {
          ctx.ui.notify("Nothing pending approval.", "info");
          return;
        }

        // Show the pending op details to the operator.
        const opLine = `Op:      ${pending.op}`;
        const displayLine = `Command: ${pending.display}`;
        const tsLine = `Queued:  ${pending.ts}`;

        // If a TUI overlay is available, require explicit confirmation.
        const customUi = (ctx?.ui as any)?.custom;
        if (typeof customUi === "function") {
          const title = `/approve — authorize blocked ${pending.op}?`;
          const detail = [opLine, displayLine, tsLine].join("\n");
          const result = (await customUi(
            (tui: any, theme: any, _kb: any, done: (r: { approved: boolean }) => void) =>
              new ConfirmInput(tui, theme, title, detail, done),
            { overlay: true, overlayOptions: { width: "70%", maxHeight: "40%", anchor: "top-center", offsetY: 2 } },
          )) as { approved: boolean } | undefined;
          if (!result?.approved) {
            ctx.ui.notify("Approval cancelled — pending op left in place.", "info");
            return;
          }
        } else {
          // Non-TUI: the human typed /approve, which is already explicit intent.
          // Show the details before minting so they're visible in the transcript.
          ctx.ui.notify(
            `Approving pending op:\n  ${opLine}\n  ${displayLine}\n  ${tsLine}`,
            "info",
          );
        }

        // Mint the token.
        const { expiresAt } = await mintControllerToken(runsDir, {
          op: pending.op,
          argsHash: pending.argsHash,
        });
        await clearPendingControllerApproval(runsDir);

        ctx.ui.notify(
          `Approved ${pending.op}: ${pending.display}\nRe-run the command now (token valid until ${expiresAt}).`,
          "info",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/approve failed: ${msg}`, "error");
      }
    },
  });

  // /deny — clear the pending record without authorizing.
  pi.registerCommand("deny", {
    description: "Clear the pending blocked Layer-C op without authorizing it. Usage: /deny",
    handler: async (_args: string, ctx) => {
      try {
        await clearPendingControllerApproval(runsDir);
        ctx.ui.notify("Pending approval cleared.", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/deny failed: ${msg}`, "error");
      }
    },
  });
}
