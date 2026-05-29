import { describe, it, expect, vi, beforeEach } from "vitest";

// We mock fs/promises BEFORE importing the module under test so the
// mock is in place when the module resolves its imports.
vi.mock("fs/promises", () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  realpath: vi.fn(),
}));

// doctor.ts (Task 10) added real I/O: existsSync(secrets.db) + keyring diagnosis.
// Mock them so the doctor test stays hermetic and deterministic regardless of
// the developer's actual ~/.pi vault/keychain state.
vi.mock("fs", async (importActual) => {
  const actual = await importActual<typeof import("fs")>();
  return {
    ...actual,
    // Skip the vault/recovery check block: pretend the vault DB doesn't exist.
    existsSync: (p: any) => (String(p).includes("secrets.db") ? false : actual.existsSync(p)),
  };
});
vi.mock("../../../src/secrets/Keyring.js", () => ({
  diagnoseKeyring: () => ({ status: "ok" }),
  createKeyringBackend: () => null,
  KEYRING_SERVICE: "pi-engineering",
  KEYRING_ACCOUNT_MASTER: "secrets-master",
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
      if (String(p).endsWith(".yaml")) {
        const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return Promise.reject(err) as any;
      }
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
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.mocked(stat).mockRejectedValue(enoent);
    vi.mocked(readFile).mockRejectedValue(enoent);
    vi.mocked(readdir).mockRejectedValue(enoent);
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
    {
      const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      vi.mocked(readFile).mockRejectedValue(enoent);
    }
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
