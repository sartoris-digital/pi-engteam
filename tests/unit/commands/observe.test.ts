import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock child_process before importing the module under test
// ---------------------------------------------------------------------------
vi.mock("child_process", () => {
  const fakeProcess = {
    on: vi.fn(),
    kill: vi.fn(),
    stdio: "pipe" as const,
  };
  return {
    spawn: vi.fn(() => fakeProcess),
    __fakeProcess: fakeProcess,
  };
});

function buildMockCtx() {
  const notify = vi.fn();
  return {
    ui: { notify },
    get lastMessage(): string { return (notify.mock.calls[0]?.[0] as string) ?? ""; },
  };
}

// ---------------------------------------------------------------------------
// Isolate module state between tests by re-importing with vi.resetModules
// ---------------------------------------------------------------------------
describe("/observe command handler", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("isServerRunning returns true when server is reachable", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const { isServerRunning } = await import(
      "../../../src/commands/observe.js"
    );
    const result = await isServerRunning(4747);
    expect(result).toBe(true);
  });

  it("isServerRunning returns false when server fetch throws (not running)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mockFetch);

    const { isServerRunning } = await import(
      "../../../src/commands/observe.js"
    );
    const result = await isServerRunning(4747);
    expect(result).toBe(false);
  });

  it("isServerRunning returns false when server responds with non-ok status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", mockFetch);

    const { isServerRunning } = await import(
      "../../../src/commands/observe.js"
    );
    const result = await isServerRunning(4747);
    expect(result).toBe(false);
  });

  it("handler notifies 'already running' when isServerRunning is true", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const { registerObserveCommand } = await import(
      "../../../src/commands/observe.js"
    );

    let capturedHandler: Function | null = null;
    const fakePi = {
      registerCommand: vi.fn((_name: string, opts: any) => {
        capturedHandler = opts.handler;
      }),
    };

    registerObserveCommand(fakePi as any);
    expect(fakePi.registerCommand).toHaveBeenCalledOnce();

    const ctx = buildMockCtx();
    await capturedHandler!("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledOnce();
    expect(ctx.lastMessage).toMatch(/already running/i);
    expect(ctx.lastMessage).toContain("4747");
  });

  it("handler notifies 'stopped' when stop=true and server process exists", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    const { registerObserveCommand, _setServerProcess } = await import(
      "../../../src/commands/observe.js"
    );

    const fakeProc = { kill: vi.fn(), on: vi.fn() };
    _setServerProcess(fakeProc as any);

    let capturedHandler: Function | null = null;
    const fakePi = {
      registerCommand: vi.fn((_name: string, opts: any) => {
        capturedHandler = opts.handler;
      }),
    };

    registerObserveCommand(fakePi as any);
    const ctx = buildMockCtx();
    await capturedHandler!("stop", ctx);
    expect(ctx.lastMessage).toBe("Observability server stopped.");
    expect(fakeProc.kill).toHaveBeenCalledOnce();
  });

  it("handler notifies 'No server running' when stop=true and serverProcess is null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    const { registerObserveCommand } = await import(
      "../../../src/commands/observe.js"
    );

    let capturedHandler: Function | null = null;
    const fakePi = {
      registerCommand: vi.fn((_name: string, opts: any) => {
        capturedHandler = opts.handler;
      }),
    };

    registerObserveCommand(fakePi as any);
    const ctx = buildMockCtx();
    await capturedHandler!("stop", ctx);
    expect(ctx.lastMessage).toBe("No observability server is running.");
  });

  it("registerCommand is called with 'observe' as the first argument", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const { registerObserveCommand } = await import(
      "../../../src/commands/observe.js"
    );

    const fakePi = { registerCommand: vi.fn() };
    registerObserveCommand(fakePi as any);

    expect(fakePi.registerCommand.mock.calls[0][0]).toBe("observe");
  });
});
