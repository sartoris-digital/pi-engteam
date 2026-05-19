// tests/unit/approval/phase3-approval-fs.test.ts
//
// PLAN.md ApprovalWatcher Phase 3 — directory layout + lstat/chmod
// guard tests. Phase 3 lands shared fs helpers used by Phases 4-10.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, chmod, stat, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("ApprovalWatcher Phase 3 — ensureApprovalsLayout", () => {
  let realHome: string | undefined;
  let tmpHome: string;
  let runsDir: string;

  beforeEach(async () => {
    realHome = process.env.HOME;
    tmpHome = await mkdtemp(join(tmpdir(), "approval-phase3-"));
    process.env.HOME = tmpHome;
    runsDir = join(tmpHome, "runs");
    await mkdir(runsDir, { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("fresh run: creates all 4 dirs at 0o700", async () => {
    const { ensureApprovalsLayout } = await import("../../../src/safety/approval-fs.js");
    const runId = "test-run-1";
    await mkdir(join(runsDir, runId), { recursive: true });

    const result = await ensureApprovalsLayout(runsDir, runId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const dir of [result.approvalsDir, result.pendingDir, result.metaDir, result.quarantineDir]) {
      const st = await stat(dir);
      expect(st.isDirectory()).toBe(true);
      expect(st.mode & 0o777).toBe(0o700);
    }
  });

  it("pre-existing 0o755 approvals/: chmod'd to 0o700", async () => {
    const { ensureApprovalsLayout } = await import("../../../src/safety/approval-fs.js");
    const runId = "test-run-2";
    const approvalsDir = join(runsDir, runId, "approvals");
    await mkdir(approvalsDir, { recursive: true, mode: 0o755 });
    await chmod(approvalsDir, 0o755);
    // Verify start state
    expect((await stat(approvalsDir)).mode & 0o777).toBe(0o755);

    const result = await ensureApprovalsLayout(runsDir, runId);
    expect(result.ok).toBe(true);
    expect((await stat(approvalsDir)).mode & 0o777).toBe(0o700);
  });

  it("symlinked approvals/: refuses + writes incident", async () => {
    const { ensureApprovalsLayout } = await import("../../../src/safety/approval-fs.js");
    const runId = "test-run-3";
    await mkdir(join(runsDir, runId), { recursive: true });
    // Create a real dir outside the run tree, then symlink into the run
    const decoy = join(tmpHome, "decoy");
    await mkdir(decoy, { recursive: true });
    await symlink(decoy, join(runsDir, runId, "approvals"));

    const result = await ensureApprovalsLayout(runsDir, runId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("symlink-detected");
    expect(result.suspectPath).toContain("approvals");

    // Incident log written outside the suspect tree
    const incidentLog = join(tmpHome, ".pi", "engineering-team", "approval-watcher-incidents.jsonl");
    const raw = await readFile(incidentLog, "utf8");
    expect(raw).toContain('"reason":"symlink-detected"');
    expect(raw).toContain('"runId":"test-run-3"');
  });

  it("non-directory at approvals/: refuses", async () => {
    const { ensureApprovalsLayout } = await import("../../../src/safety/approval-fs.js");
    const runId = "test-run-4";
    await mkdir(join(runsDir, runId), { recursive: true });
    await writeFile(join(runsDir, runId, "approvals"), "not-a-dir");

    const result = await ensureApprovalsLayout(runsDir, runId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("non-directory");
  });

  it("symlinked pending/: refuses", async () => {
    const { ensureApprovalsLayout } = await import("../../../src/safety/approval-fs.js");
    const runId = "test-run-5";
    const approvalsDir = join(runsDir, runId, "approvals");
    await mkdir(approvalsDir, { recursive: true, mode: 0o700 });
    const decoy = join(tmpHome, "pending-decoy");
    await mkdir(decoy, { recursive: true });
    await symlink(decoy, join(approvalsDir, "pending"));

    const result = await ensureApprovalsLayout(runsDir, runId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("symlink-detected");
    expect(result.suspectPath).toMatch(/pending$/);
  });

  it("idempotent — second call on a healthy tree returns ok unchanged", async () => {
    const { ensureApprovalsLayout } = await import("../../../src/safety/approval-fs.js");
    const runId = "test-run-6";
    await mkdir(join(runsDir, runId), { recursive: true });

    const first = await ensureApprovalsLayout(runsDir, runId);
    expect(first.ok).toBe(true);

    const second = await ensureApprovalsLayout(runsDir, runId);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Same paths returned
    if (first.ok) {
      expect(second.approvalsDir).toBe(first.approvalsDir);
      expect(second.pendingDir).toBe(first.pendingDir);
    }
  });
});

describe("ApprovalWatcher Phase 3 — repairApprovalTokenPermissions", () => {
  let realHome: string | undefined;
  let tmpHome: string;
  let approvalsDir: string;

  beforeEach(async () => {
    realHome = process.env.HOME;
    tmpHome = await mkdtemp(join(tmpdir(), "approval-phase3-perm-"));
    process.env.HOME = tmpHome;
    approvalsDir = join(tmpHome, "runs", "test-run", "approvals");
    await mkdir(approvalsDir, { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("chmods *.json token files to 0o600", async () => {
    const { repairApprovalTokenPermissions } = await import("../../../src/safety/approval-fs.js");
    const token = join(approvalsDir, "abc.json");
    await writeFile(token, "{}", { mode: 0o644 });
    expect((await stat(token)).mode & 0o777).toBe(0o644);

    await repairApprovalTokenPermissions(approvalsDir);
    expect((await stat(token)).mode & 0o777).toBe(0o600);
  });

  it("ignores *.json.consumed (already-spent tokens)", async () => {
    const { repairApprovalTokenPermissions } = await import("../../../src/safety/approval-fs.js");
    const consumed = join(approvalsDir, "abc.json.consumed");
    await writeFile(consumed, "{}", { mode: 0o644 });

    await repairApprovalTokenPermissions(approvalsDir);
    expect((await stat(consumed)).mode & 0o777).toBe(0o644); // unchanged
  });

  it("ignores non-.json entries", async () => {
    const { repairApprovalTokenPermissions } = await import("../../../src/safety/approval-fs.js");
    const other = join(approvalsDir, "notes.txt");
    await writeFile(other, "hello", { mode: 0o644 });

    await repairApprovalTokenPermissions(approvalsDir);
    expect((await stat(other)).mode & 0o777).toBe(0o644); // unchanged
  });

  it("safe to call on a missing approvals dir", async () => {
    const { repairApprovalTokenPermissions } = await import("../../../src/safety/approval-fs.js");
    await expect(
      repairApprovalTokenPermissions(join(tmpHome, "nonexistent")),
    ).resolves.toBeUndefined();
  });
});

describe("ApprovalWatcher Phase 3 — containment check (lexical)", () => {
  it("isContainedLexical true when target === root", async () => {
    const { __test } = await import("../../../src/safety/approval-fs.js");
    expect(__test.isContainedLexical("/tmp/foo", "/tmp/foo")).toBe(true);
  });

  it("isContainedLexical true when target is direct child", async () => {
    const { __test } = await import("../../../src/safety/approval-fs.js");
    expect(__test.isContainedLexical("/tmp/foo/bar", "/tmp/foo")).toBe(true);
  });

  it("isContainedLexical false when target is sibling-prefix", async () => {
    const { __test } = await import("../../../src/safety/approval-fs.js");
    expect(__test.isContainedLexical("/tmp/foo-bar", "/tmp/foo")).toBe(false);
  });
});

describe("ApprovalWatcher Phase 3 — containment check (strict realpath)", () => {
  let realHome: string | undefined;
  let tmpHome: string;

  beforeEach(async () => {
    realHome = process.env.HOME;
    tmpHome = await mkdtemp(join(tmpdir(), "approval-phase3-contain-"));
    process.env.HOME = tmpHome;
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("strict isContainedUnder returns false when target cannot be resolved (Round-3 HIGH 2)", async () => {
    const { __test } = await import("../../../src/safety/approval-fs.js");
    // Neither path exists → realpath fails → strict refuses.
    expect(await __test.isContainedUnder(join(tmpHome, "does-not-exist"), join(tmpHome, "also-missing"))).toBe(false);
  });

  it("strict isContainedUnder returns true when both resolve and target is under root", async () => {
    const { __test } = await import("../../../src/safety/approval-fs.js");
    const root = join(tmpHome, "root");
    const child = join(root, "child");
    await mkdir(child, { recursive: true });
    expect(await __test.isContainedUnder(child, root)).toBe(true);
  });

  it("strict isContainedUnder returns false when symlink escapes root", async () => {
    const { __test } = await import("../../../src/safety/approval-fs.js");
    const root = join(tmpHome, "root");
    const outside = join(tmpHome, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    const linked = join(root, "escape");
    await symlink(outside, linked);
    // realpath(linked) === outside, which is not under root.
    expect(await __test.isContainedUnder(linked, root)).toBe(false);
  });
});

describe("ApprovalWatcher Phase 3 — TOCTOU-safe chmod via fd (Round-3 HIGH 1)", () => {
  let realHome: string | undefined;
  let tmpHome: string;
  let runsDir: string;

  beforeEach(async () => {
    realHome = process.env.HOME;
    tmpHome = await mkdtemp(join(tmpdir(), "approval-phase3-toctou-"));
    process.env.HOME = tmpHome;
    runsDir = join(tmpHome, "runs");
    await mkdir(runsDir, { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("symlink at approvals/ is refused via O_NOFOLLOW (ELOOP) without ever chmod'ing the target", async () => {
    const { ensureApprovalsLayout } = await import("../../../src/safety/approval-fs.js");
    const runId = "toctou-1";
    await mkdir(join(runsDir, runId), { recursive: true });
    // Plant a symlink victim with a sentinel mode that we'd notice if
    // chmod-through-link happened.
    const victim = join(tmpHome, "victim");
    await mkdir(victim, { recursive: true });
    await chmod(victim, 0o755);
    await symlink(victim, join(runsDir, runId, "approvals"));

    const result = await ensureApprovalsLayout(runsDir, runId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("symlink-detected");

    // Victim mode unchanged — chmod did not follow the symlink.
    const victimMode = (await stat(victim)).mode & 0o777;
    expect(victimMode).toBe(0o755);
  });

  it("ensureApprovalsLayout chmods via fd: fresh dirs end at 0o700 regardless of umask", async () => {
    const { ensureApprovalsLayout } = await import("../../../src/safety/approval-fs.js");
    const runId = "toctou-2";
    await mkdir(join(runsDir, runId), { recursive: true });
    const result = await ensureApprovalsLayout(runsDir, runId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const dir of [result.approvalsDir, result.pendingDir, result.metaDir, result.quarantineDir]) {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
  });

  it("repairApprovalTokenPermissions does not follow a symlinked token", async () => {
    const { repairApprovalTokenPermissions, ensureApprovalsLayout } = await import(
      "../../../src/safety/approval-fs.js"
    );
    const runId = "toctou-3";
    await mkdir(join(runsDir, runId), { recursive: true });
    const layout = await ensureApprovalsLayout(runsDir, runId);
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;

    // Victim outside the run tree, with a sentinel mode.
    const victim = join(tmpHome, "outside-token");
    await writeFile(victim, "{}", { mode: 0o644 });
    // Symlinked token under approvals/
    await symlink(victim, join(layout.approvalsDir, "linked.json"));

    await repairApprovalTokenPermissions(layout.approvalsDir);

    // Victim mode unchanged — chmod did not follow the symlink.
    expect((await stat(victim)).mode & 0o777).toBe(0o644);
  });
});
