import { describe, it, expect, vi, beforeEach } from "vitest";

// We mock fs/promises BEFORE importing the module under test so the
// mock is in place when the module resolves its imports.
vi.mock("fs/promises", () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  realpath: vi.fn(),
}));

import { stat, readFile, readdir, realpath } from "fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Dynamically re-import after mock is set up
async function loadDoctor() {
  const mod = await import("../../../src/commands/doctor.js");
  return mod.registerDoctorCommand;
}

function buildMockPi(): { registerCommand: ReturnType<typeof vi.fn>; lastHandler: any } {
  let lastHandler: any;
  const registerCommand = vi.fn((_name: string, opts: any) => {
    lastHandler = opts.handler;
  });
  return {
    registerCommand,
    get lastHandler() { return lastHandler; },
  };
}

function buildMockCtx() {
  const notify = vi.fn();
  return {
    ui: { notify },
    get lastMessage(): string { return (notify.mock.calls[0]?.[0] as string) ?? ""; },
  };
}

describe("registerDoctorCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("registers a command named 'engineering-doctor'", async () => {
    const registerDoctorCommand = await loadDoctor();
    const mock = buildMockPi();
    registerDoctorCommand(mock as unknown as ExtensionAPI);
    expect(mock.registerCommand).toHaveBeenCalledOnce();
    expect(mock.registerCommand.mock.calls[0][0]).toBe("engineering-doctor");
  });

  it("reports all checks passed when all files exist and safety.json is valid JSON", async () => {
    const registerDoctorCommand = await loadDoctor();
    vi.mocked(stat).mockResolvedValue({} as any);
    // readFile returns content with "team:" for agent .md checks; safety.json valid for that call
    vi.mocked(readFile).mockImplementation((p: any) => {
      if (String(p).endsWith(".json")) return Promise.resolve('{"hardBlockers":{"enabled":true,"alwaysOn":true}}') as any;
      // yaml files → empty (no user/project overrides)
      if (String(p).endsWith(".yaml")) return Promise.reject(new Error("ENOENT")) as any;
      // agent .md files → content with team: field
      return Promise.resolve("---\nteam: planning\n---\n") as any;
    });
    // readdir returns a fake list of agent .md files (all with team: field via readFile mock)
    vi.mocked(readdir).mockResolvedValue(["planner.md", "implementer.md"] as any);
    // realpath used by loadTeamsConfig — return path unchanged
    vi.mocked(realpath).mockImplementation((p: any) => Promise.resolve(String(p)));

    const mock = buildMockPi();
    registerDoctorCommand(mock as unknown as ExtensionAPI);

    const ctx = buildMockCtx();
    await mock.lastHandler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledOnce();
    expect(ctx.lastMessage).toContain("All checks passed.");
    expect(ctx.lastMessage).not.toContain("✗");
  });

  it("reports failures when extension file is missing", async () => {
    const registerDoctorCommand = await loadDoctor();
    vi.mocked(stat).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(readdir).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(realpath).mockImplementation((p: any) => Promise.resolve(String(p)));

    const mock = buildMockPi();
    registerDoctorCommand(mock as unknown as ExtensionAPI);

    const ctx = buildMockCtx();
    await mock.lastHandler("", ctx);
    expect(ctx.lastMessage).toContain("✗");
    expect(ctx.lastMessage).toContain("issues");
    expect(ctx.lastMessage).toContain("pnpm install:extension");
  });

  it("includes all 14 agent checks", async () => {
    const registerDoctorCommand = await loadDoctor();
    vi.mocked(stat).mockResolvedValue({} as any);
    vi.mocked(readFile).mockResolvedValue("{}");
    vi.mocked(readdir).mockResolvedValue([] as any);
    vi.mocked(realpath).mockImplementation((p: any) => Promise.resolve(String(p)));

    const mock = buildMockPi();
    registerDoctorCommand(mock as unknown as ExtensionAPI);

    const ctx = buildMockCtx();
    await mock.lastHandler("", ctx);
    const agentNames = [
      "planner", "implementer", "reviewer", "architect", "codebase-cartographer",
      "tester", "security-auditor", "performance-analyst", "bug-triage", "incident-investigator",
      "root-cause-debugger", "judge", "knowledge-retriever", "observability-archivist",
    ];
    for (const name of agentNames) {
      expect(ctx.lastMessage).toContain(`Agent: ${name}`);
    }
  });

  it("reports safety.json issue but does not fail hard when safety.json is absent", async () => {
    const registerDoctorCommand = await loadDoctor();
    vi.mocked(stat).mockResolvedValue({} as any);
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(readdir).mockResolvedValue([] as any);
    vi.mocked(realpath).mockImplementation((p: any) => Promise.resolve(String(p)));

    const mock = buildMockPi();
    registerDoctorCommand(mock as unknown as ExtensionAPI);

    const ctx = buildMockCtx();
    await mock.lastHandler("", ctx);
    expect(ctx.lastMessage).toContain("safety.json");
    expect(ctx.lastMessage).toContain("Missing or invalid");
  });
});
