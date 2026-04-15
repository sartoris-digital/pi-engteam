import { mkdtemp, mkdir, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

describe("spawnFlush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns node with the flush script and snapshot path", async () => {
    const { spawn } = await import("child_process");
    const { spawnFlush } = await import("../../../src/memory/spawnFlush.js");

    spawnFlush("/tmp/pi-flush-test.json", "/tmp/memory-scripts");

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["/tmp/memory-scripts/flush.mjs", "/tmp/pi-flush-test.json"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });

  it("unrefs the detached child process", async () => {
    const { spawn } = await import("child_process");
    const mockChild = { unref: vi.fn() };
    vi.mocked(spawn).mockReturnValue(mockChild as any);
    const { spawnFlush } = await import("../../../src/memory/spawnFlush.js");

    spawnFlush("/tmp/pi-flush-test.json", "/tmp/memory-scripts");

    expect(mockChild.unref).toHaveBeenCalled();
  });
});

describe("ensureScriptsInstalled", () => {
  it("copies missing bundled scripts into the destination", async () => {
    const srcDir = await mkdtemp(join(tmpdir(), "memory-src-"));
    const destDir = await mkdtemp(join(tmpdir(), "memory-dest-"));
    await mkdir(join(srcDir, "lib"), { recursive: true });

    const sourceFiles = {
      "flush.mjs": "// flush",
      "lib/config.mjs": "// config",
      "lib/logWriter.mjs": "// log writer",
      "lib/transcript.mjs": "// transcript",
    };

    await Promise.all(
      Object.entries(sourceFiles).map(async ([path, contents]) => {
        await writeFile(join(srcDir, path), contents, "utf8");
      }),
    );

    const { ensureScriptsInstalled } = await import("../../../src/memory/spawnFlush.js");
    await ensureScriptsInstalled(destDir, srcDir);

    expect(await readFile(join(destDir, "flush.mjs"), "utf8")).toBe("// flush");
    expect(await readFile(join(destDir, "lib", "config.mjs"), "utf8")).toBe("// config");
  });
});
