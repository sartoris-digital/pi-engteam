import { matchesKey } from "@mariozechner/pi-tui";
import type { Component, TUI } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

/**
 * Single-line masked input for collecting a secret value inside a Pi
 * extension without putting the keystrokes in the chat scrollback.
 *
 * Why this exists: /secret-set used to open a raw `readline` interface
 * on process.stdin, which fought with Pi's TUI for keystrokes and hung
 * the session. The flag-based path (`--value`, `--from-file`) avoids
 * the readline entirely but leaves `--value` secrets in chat history.
 * This component is the third option: pop a Pi TUI overlay that masks
 * keystrokes with bullets, submits on Enter, cancels on Esc.
 *
 * Submitted via ctx.ui.custom(...) — done() is called once with the
 * collected value (possibly empty if the user submits without typing,
 * or undefined-but-encoded-as-empty when cancelled — the caller
 * inspects the returned shape and decides what to do).
 */
export class PasswordInput implements Component {
  private buffer = "";
  // Track cancel so the caller can distinguish "" from cancellation.
  private cancelled = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly prompt: string,
    private readonly done: (result: { value: string; cancelled: boolean }) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "enter") || matchesKey(data, "ctrl+enter")) {
      this.done({ value: this.buffer, cancelled: false });
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.cancelled = true;
      this.done({ value: "", cancelled: true });
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.buffer = this.buffer.slice(0, -1);
      this.tui.requestRender();
      return;
    }
    // Pi delivers a string for every keystroke. Filter to single printable
    // characters so escape sequences, arrows, etc. don't leak into the
    // buffer as multibyte garbage. Codex round-1 #7: also strip bracketed
    // paste markers (`\x1b[200~…\x1b[201~`) and refuse any control byte
    // inside a pasted blob, so an embedded Ctrl-C or backspace can't
    // silently corrupt the buffer.
    if (data.length === 1) {
      const cp = data.charCodeAt(0);
      // Printable ASCII range. Reject control chars (NUL, BEL, etc.).
      if (cp >= 0x20 && cp <= 0x7e) {
        this.buffer += data;
        this.tui.requestRender();
        return;
      }
      return;
    }
    // Multi-byte input (paste, IME, etc.). Strip bracketed-paste markers
    // first, then filter out any control byte from the remainder. The
    // surviving characters are accepted whether single- or multi-byte
    // (a paste of a base64 token, or a passphrase that contains
    // non-ASCII glyphs).
    let payload = data.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
    // Drop ESC-prefixed sequences entirely (cursor keys, function keys, …).
    if (payload.charCodeAt(0) === 0x1b) return;
    // Reject any control byte (NUL, BEL, BS, LF, CR, ESC, DEL, …) anywhere
    // in the surviving payload. Allowing them produced silent corruption
    // of the buffer when a paste contained Ctrl-C / Ctrl-Z / newlines.
    let safe = "";
    for (let i = 0; i < payload.length; i++) {
      const cp = payload.charCodeAt(i);
      if (cp >= 0x20 && cp !== 0x7f) safe += payload[i];
    }
    if (safe.length === 0) return;
    this.buffer += safe;
    this.tui.requestRender();
  }

  render(_width: number): string[] {
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.prompt));
    lines.push("");
    // Mask with bullets. Show a trailing block as a cursor hint.
    const bullets = "•".repeat(this.buffer.length);
    lines.push(this.theme.fg("muted", bullets + "█"));
    lines.push("");
    if (this.cancelled) {
      lines.push(this.theme.fg("error", "Cancelled."));
    } else {
      lines.push(this.theme.fg("muted", `${this.buffer.length} char${this.buffer.length === 1 ? "" : "s"}  ·  Enter submit  ·  Esc cancel  ·  Backspace`));
    }
    return lines;
  }

  invalidate(): void {
    // No-op: this component has no child components and re-renders fully.
  }
}
