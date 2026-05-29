import { describe, it, expect, vi, afterEach } from "vitest";
import { ConfirmInput, inlineOperatorApproval } from "../../../src/ui/ConfirmInput.js";

function makeMockTui() {
  return {} as any;
}

function makeMockTheme() {
  return { fg: (_color: string, text: string) => text } as any;
}

// ─── ConfirmInput component ───────────────────────────────────────────────────

describe("ConfirmInput", () => {
  it("'y' calls done with { approved: true }", () => {
    const done = vi.fn();
    const c = new ConfirmInput(makeMockTui(), makeMockTheme(), "title", "detail", done);
    c.handleInput("y");
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith({ approved: true });
  });

  it("'Y' calls done with { approved: true }", () => {
    const done = vi.fn();
    const c = new ConfirmInput(makeMockTui(), makeMockTheme(), "title", "detail", done);
    c.handleInput("Y");
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith({ approved: true });
  });

  it("'n' calls done with { approved: false }", () => {
    const done = vi.fn();
    const c = new ConfirmInput(makeMockTui(), makeMockTheme(), "title", "detail", done);
    c.handleInput("n");
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith({ approved: false });
  });

  it("'N' calls done with { approved: false }", () => {
    const done = vi.fn();
    const c = new ConfirmInput(makeMockTui(), makeMockTheme(), "title", "detail", done);
    c.handleInput("N");
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith({ approved: false });
  });

  it("Escape sequence calls done with { approved: false }", () => {
    const done = vi.fn();
    const c = new ConfirmInput(makeMockTui(), makeMockTheme(), "title", "detail", done);
    // \x1b is the raw ESC byte — matchesKey(data, "escape") recognises it
    c.handleInput("\x1b");
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith({ approved: false });
  });

  it("unrecognised key does not call done (no accidental approve)", () => {
    const done = vi.fn();
    const c = new ConfirmInput(makeMockTui(), makeMockTheme(), "title", "detail", done);
    c.handleInput("x");
    c.handleInput("z");
    c.handleInput(" ");
    expect(done).not.toHaveBeenCalled();
  });

  it("render() includes title and prompt text", () => {
    const done = vi.fn();
    const c = new ConfirmInput(makeMockTui(), makeMockTheme(), "My Title", "detail line", done);
    const lines = c.render(80);
    const output = lines.join("\n");
    expect(output).toContain("My Title");
    expect(output).toContain("detail line");
    expect(output).toContain("y = APPROVE");
  });

  it("render() includes multi-line detail", () => {
    const done = vi.fn();
    const c = new ConfirmInput(makeMockTui(), makeMockTheme(), "T", "line1\nline2", done);
    const lines = c.render(80);
    const output = lines.join("\n");
    expect(output).toContain("line1");
    expect(output).toContain("line2");
  });

  it("invalidate() does not throw", () => {
    const c = new ConfirmInput(makeMockTui(), makeMockTheme(), "T", "D", vi.fn());
    expect(() => c.invalidate()).not.toThrow();
  });
});

// ─── inlineOperatorApproval helper ───────────────────────────────────────────

describe("inlineOperatorApproval", () => {
  afterEach(() => {
    delete process.env["PI_ENGINEERING_RUN_ID"];
  });

  it("returns false without calling ctx.ui.custom when PI_ENGINEERING_RUN_ID is set", async () => {
    process.env["PI_ENGINEERING_RUN_ID"] = "run-abc";
    const custom = vi.fn();
    const ctx = { ui: { custom } };
    const result = await inlineOperatorApproval(ctx, "destructive command", "rm -rf /tmp/foo");
    expect(result).toBe(false);
    expect(custom).not.toHaveBeenCalled();
  });

  it("returns false when ctx has no ui.custom", async () => {
    const ctx = { ui: {} };
    const result = await inlineOperatorApproval(ctx, "Write", "/some/path");
    expect(result).toBe(false);
  });

  it("returns false when ctx is undefined", async () => {
    const result = await inlineOperatorApproval(undefined, "Write", "/some/path");
    expect(result).toBe(false);
  });

  it("returns true when ctx.ui.custom resolves { approved: true }", async () => {
    const custom = vi.fn().mockResolvedValue({ approved: true });
    const ctx = { ui: { custom } };
    const result = await inlineOperatorApproval(ctx, "Write", "/some/path");
    expect(result).toBe(true);
    expect(custom).toHaveBeenCalledOnce();
  });

  it("returns false when ctx.ui.custom resolves { approved: false }", async () => {
    const custom = vi.fn().mockResolvedValue({ approved: false });
    const ctx = { ui: { custom } };
    const result = await inlineOperatorApproval(ctx, "Write", "/some/path");
    expect(result).toBe(false);
    expect(custom).toHaveBeenCalledOnce();
  });

  it("returns false when ctx.ui.custom resolves undefined (safety net)", async () => {
    const custom = vi.fn().mockResolvedValue(undefined);
    const ctx = { ui: { custom } };
    const result = await inlineOperatorApproval(ctx, "Bash", "rm file");
    expect(result).toBe(false);
  });
});
