import { describe, it, expect, vi, beforeEach } from "vitest";

// We mock fs/promises BEFORE importing the module under test so the
// mock is in place when the module resolves its imports.
vi.mock("fs/promises", () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
}));

import { stat, readFile } from "fs/promises";
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

describe("registerDoctorCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("registers a command named 'engteam-doctor'", async () => {
    const registerDoctorCommand = await loadDoctor();
    const mock = buildMockPi();
    registerDoctorCommand(mock as unknown as ExtensionAPI);
    expect(mock.registerCommand).toHaveBeenCalledOnce();
    expect(mock.registerCommand.mock.calls[0][0]).toBe("engteam-doctor");
  });

  it("reports all checks passed when all files exist and safety.json is valid JSON", async () => {
    const registerDoctorCommand = await loadDoctor();
    vi.mocked(stat).mockResolvedValue({} as any);
    vi.mocked(readFile).mockResolvedValue('{"hardBlockers":{"enabled":true,"alwaysOn":true}}');

    const mock = buildMockPi();
    registerDoctorCommand(mock as unknown as ExtensionAPI);

    const result = await mock.lastHandler({}, {});
    expect(result.message).toContain("All checks passed.");
    expect(result.message).not.toContain("✗");
  });

  it("reports failures when extension file is missing", async () => {
    const registerDoctorCommand = await loadDoctor();
    vi.mocked(stat).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

    const mock = buildMockPi();
    registerDoctorCommand(mock as unknown as ExtensionAPI);

    const result = await mock.lastHandler({}, {});
    expect(result.message).toContain("✗");
    expect(result.message).toContain("issues");
    expect(result.message).toContain("pnpm install:extension");
  });

  it("includes all 14 agent checks", async () => {
    const registerDoctorCommand = await loadDoctor();
    vi.mocked(stat).mockResolvedValue({} as any);
    vi.mocked(readFile).mockResolvedValue("{}");

    const mock = buildMockPi();
    registerDoctorCommand(mock as unknown as ExtensionAPI);

    const result = await mock.lastHandler({}, {});
    const agentNames = [
      "planner", "implementer", "reviewer", "architect", "codebase-cartographer",
      "tester", "security-auditor", "performance-analyst", "bug-triage", "incident-investigator",
      "root-cause-debugger", "judge", "knowledge-retriever", "observability-archivist",
    ];
    for (const name of agentNames) {
      expect(result.message).toContain(`Agent: ${name}`);
    }
  });

  it("reports safety.json issue but does not fail hard when safety.json is absent", async () => {
    const registerDoctorCommand = await loadDoctor();
    // stat succeeds for everything except safety.json is handled by readFile
    vi.mocked(stat).mockResolvedValue({} as any);
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

    const mock = buildMockPi();
    registerDoctorCommand(mock as unknown as ExtensionAPI);

    const result = await mock.lastHandler({}, {});
    expect(result.message).toContain("safety.json");
    expect(result.message).toContain("Missing or invalid");
  });
});
