import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  detectSeeds,
  maybeSeed,
  seedPath,
  SEED_INTERPRETERS,
  snapshotSeed,
  type SeedRecord,
} from "../../../src/codify/seeds.js";

async function tmpRoot(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("SEED_INTERPRETERS", () => {
  it("freezes python|uv|node|bash|pwsh", () => {
    expect(SEED_INTERPRETERS.has("python")).toBe(true);
    expect(SEED_INTERPRETERS.has("uv")).toBe(true);
    expect(SEED_INTERPRETERS.has("node")).toBe(true);
    expect(SEED_INTERPRETERS.has("bash")).toBe(true);
    expect(SEED_INTERPRETERS.has("pwsh")).toBe(true);
  });
});

describe("detectSeeds", () => {
  it("intersects a python run against a created script", () => {
    const hits = detectSeeds({
      createdFiles: ["scripts/sync_aem.py", "README.md"],
      commands: [
        { argv: ["python", "scripts/sync_aem.py"], exitCode: 0 },
        { argv: ["cat", "README.md"], exitCode: 0 },
      ],
      declared: [],
    });
    expect(hits).toEqual([{ path: "scripts/sync_aem.py", argv: ["python", "scripts/sync_aem.py"] }]);
  });

  it("does not seed cat README.md", () => {
    expect(
      detectSeeds({
        createdFiles: ["README.md"],
        commands: [{ argv: ["cat", "README.md"], exitCode: 0 }],
        declared: [],
      }),
    ).toEqual([]);
  });

  it("seeds a declared script with no matching run when the file exists", () => {
    const hits = detectSeeds({
      createdFiles: ["scripts/migrate.py"],
      commands: [],
      declared: [{ path: "scripts/migrate.py", purpose: "migrate", inputsObserved: ["package.json"] }],
    });
    expect(hits).toEqual([{ path: "scripts/migrate.py", argv: ["python", "scripts/migrate.py"] }]);
  });

  it("matches uv/node/bash/pwsh by basename or path in argv", () => {
    expect(
      detectSeeds({
        createdFiles: ["tools/bump.mjs"],
        commands: [{ argv: ["uv", "run", "node", "tools/bump.mjs"], exitCode: 0 }],
        declared: [],
      }),
    ).toEqual([{ path: "tools/bump.mjs", argv: ["uv", "run", "node", "tools/bump.mjs"] }]);
  });
});

describe("seedPath / snapshotSeed", () => {
  it("writes runs/_factory/codify/seeds/<runId>-implement-0.json without env values", async () => {
    const t = await tmpRoot("pi-sdlc-seed-");
    try {
      const runsDir = join(t.dir, "runs");
      const runDir = join(runsDir, "run-1");
      const workspaceDir = join(runDir, "ws");
      await mkdir(join(workspaceDir, "scripts"), { recursive: true });
      await writeFile(join(workspaceDir, "scripts", "sync_aem.py"), "print('sync')\n", "utf8");

      const path = seedPath(runsDir, "run-1", "implement", 0);
      expect(path).toBe(join(runsDir, "_factory", "codify", "seeds", "run-1-implement-0.json"));

      const rec = await snapshotSeed({
        runsDir,
        runId: "run-1",
        stage: "implement",
        n: 0,
        scriptPath: "scripts/sync_aem.py",
        commandLines: [{ argv: ["TOKEN=s3cret-env-value", "python", "scripts/sync_aem.py"], exitCode: 0 }],
        filesRead: ["README.md"],
        envNames: ["TOKEN"],
        effect: { outputTail: "ok" },
        taskContextFenced: "```\nbump aem\n```",
        workspaceDir,
        runDir,
        writeRoots: ["docs/**", "README.md"],
      });

      expect(rec.trigger).toBe("script-seed");
      expect(rec.scriptPath).toBe("scripts/sync_aem.py");
      expect(rec.envNames).toEqual(["TOKEN"]);
      expect(JSON.stringify(rec)).not.toContain("s3cret-env-value");
      expect(rec.commandLines[0]?.argv.some((a) => a.includes("s3cret-env-value"))).toBe(false);
      expect(rec.wraps).toBeUndefined();

      const onDisk = JSON.parse(await readFile(path, "utf8")) as SeedRecord;
      expect(onDisk.runId).toBe("run-1");
      expect(onDisk.n).toBe(0);
      expect(JSON.stringify(onDisk)).not.toContain("s3cret-env-value");
    } finally {
      await t.cleanup();
    }
  });

  it("sets wraps when the created file is the ticket deliverable inside writeRoots", async () => {
    const t = await tmpRoot("pi-sdlc-seed-wrap-");
    try {
      const runsDir = join(t.dir, "runs");
      const runDir = join(runsDir, "run-2");
      const workspaceDir = join(runDir, "ws");
      await mkdir(join(workspaceDir, "docs"), { recursive: true });
      await writeFile(join(workspaceDir, "docs", "sync.py"), "print(1)\n", "utf8");

      const rec = await snapshotSeed({
        runsDir,
        runId: "run-2",
        stage: "implement",
        n: 0,
        scriptPath: "docs/sync.py",
        commandLines: [{ argv: ["python", "docs/sync.py"], exitCode: 0 }],
        filesRead: [],
        envNames: [],
        effect: {},
        taskContextFenced: "```\n```",
        workspaceDir,
        runDir,
        writeRoots: ["docs/**", "README.md"],
      });
      expect(rec.wraps).toBe("docs/sync.py");
    } finally {
      await t.cleanup();
    }
  });
});

describe("maybeSeed", () => {
  it("snapshots one seed and enqueues script-seed at priority -5", async () => {
    const t = await tmpRoot("pi-sdlc-maybe-seed-");
    try {
      const runsDir = join(t.dir, "runs");
      const runDir = join(runsDir, "run-1");
      const workspaceDir = join(runDir, "ws");
      await mkdir(join(workspaceDir, "scripts"), { recursive: true });
      await writeFile(join(workspaceDir, "scripts", "sync_aem.py"), "print('sync')\n", "utf8");

      const seeded = await maybeSeed({
        runsDir,
        runId: "run-1",
        stage: "implement",
        workspaceDir,
        runDir,
        writeRoots: ["scripts/**"],
        createdFiles: ["scripts/sync_aem.py"],
        commands: [{ argv: ["python", "scripts/sync_aem.py"], exitCode: 0 }],
        declared: [],
        taskContext: "sync staging to dev",
      });
      expect(seeded).toHaveLength(1);
      expect(seeded[0]?.scriptPath).toBe("scripts/sync_aem.py");
      await expect(readFile(seedPath(runsDir, "run-1", "implement", 0), "utf8")).resolves.toContain("script-seed");

      const inbox = (await readFile(join(runsDir, "_factory", "codify", "inbox.jsonl"), "utf8")).trim();
      const line = JSON.parse(inbox) as { trigger: string; priority: number };
      expect(line.trigger).toBe("script-seed");
      expect(line.priority).toBe(-5);
    } finally {
      await t.cleanup();
    }
  });

});

describe("detectSeeds basename", () => {
  it("uses basename of the created file", () => {
    const hits = detectSeeds({
      createdFiles: ["scripts/sync_aem.py"],
      commands: [{ argv: ["python3", "sync_aem.py"], exitCode: 0 }],
      declared: [],
    });
    expect(hits[0]?.path).toBe("scripts/sync_aem.py");
    expect(basename(hits[0]?.path ?? "")).toBe("sync_aem.py");
  });
});
