import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  dispatchOnce,
  localDestructiveOnly,
  registerApprovalDispatcher,
  type DispatchCallback,
} from "../../../src/safety/dispatch.js";
import { hashArgs, readTokenFile, tokenPath, verifyToken } from "../../../src/safety/tokens.js";
import { pendingApprovalPath, type PendingApproval } from "../../../src/worker/request-approval.js";

const SECRET = "e".repeat(64);

async function writePending(
  runDir: string,
  over: Partial<PendingApproval> & Pick<PendingApproval, "command">,
): Promise<PendingApproval> {
  const pending: PendingApproval = {
    _marker: "<!-- pi-sdlc-factory generated · run r1 · do not commit -->",
    requestId: over.requestId ?? "req-1",
    runId: over.runId ?? "r1",
    stage: over.stage ?? "implement",
    agent: over.agent ?? "implementer",
    op: over.op ?? "bash",
    command: over.command,
    justification: over.justification ?? "need it",
    requestedAt: over.requestedAt ?? "2026-09-02T00:00:00.000Z",
  };
  await mkdir(join(runDir, "approvals", "pending"), { recursive: true, mode: 0o700 });
  await writeFile(pendingApprovalPath(runDir, pending.requestId), `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
  return pending;
}

describe("localDestructiveOnly", () => {
  it("allows rm, rmdir, mv, chmod, and git stash inside the worktree", () => {
    expect(localDestructiveOnly("rm -rf tmp/out")).toBe(true);
    expect(localDestructiveOnly("rmdir empty")).toBe(true);
    expect(localDestructiveOnly("mv src/a.ts src/b.ts")).toBe(true);
    expect(localDestructiveOnly("chmod +x scripts/run.sh")).toBe(true);
    expect(localDestructiveOnly("git stash")).toBe(true);
    expect(localDestructiveOnly("git stash push -u")).toBe(true);
  });

  it("never auto-grants git push/commit, tracker CLIs, or anything that can open a socket", () => {
    expect(localDestructiveOnly("git push")).toBe(false);
    expect(localDestructiveOnly("git commit -m x")).toBe(false);
    expect(localDestructiveOnly("gh pr create")).toBe(false);
    expect(localDestructiveOnly("az boards work-item update --id 1")).toBe(false);
    expect(localDestructiveOnly("jira issue move DEMO-1 'In Progress'")).toBe(false);
    expect(localDestructiveOnly("curl https://example.com")).toBe(false);
    expect(localDestructiveOnly("wget http://127.0.0.1:1")).toBe(false);
    expect(localDestructiveOnly("nc 127.0.0.1 80")).toBe(false);
    expect(localDestructiveOnly("ssh host")).toBe(false);
    expect(localDestructiveOnly("rm foo && git push origin HEAD")).toBe(false);
    expect(localDestructiveOnly("git stash; curl http://evil")).toBe(false);
    expect(localDestructiveOnly("rm https://example.com/x")).toBe(false);
  });
});

describe("dispatchOnce", () => {
  let runDir: string;
  afterEach(async () => {
    if (runDir !== undefined) await rm(runDir, { recursive: true, force: true });
  });

  async function setup(): Promise<string> {
    runDir = await mkdtemp(join(tmpdir(), "pi-sdlc-dispatch-"));
    await writeFile(join(runDir, ".secret"), SECRET, { mode: 0o600 });
    return runDir;
  }

  const grantRm: DispatchCallback = async (pending) => ({
    grant: true,
    op: pending.op,
    argsHash: hashArgs("bash", { command: pending.command }),
  });

  it("auto-grants rm: mints a once-token that verifies with the run secret and consumes pending", async () => {
    await setup();
    const pending = await writePending(runDir, { command: "rm -rf tmp/out" });
    const result = await dispatchOnce({ runDir, secret: SECRET, callback: grantRm });
    expect(result.granted).toEqual([pending.requestId]);
    expect(existsSync(pendingApprovalPath(runDir, pending.requestId))).toBe(false);
    const granted = (await readdir(join(runDir, "approvals", "granted"))).filter((n) => n.endsWith(".json"));
    expect(granted).toHaveLength(1);
    const token = readTokenFile(runDir, granted[0]!.replace(/\.json$/, ""));
    expect(token).not.toBeNull();
    expect(verifyToken(SECRET, token!)).toBe(true);
    expect(token!.argsHash).toBe(hashArgs("bash", { command: pending.command }));
    expect(tokenPath(runDir, token!.tokenId)).toContain("approvals/granted");
  });

  it("never auto-grants git push even when the callback says grant; pending stays for /factory grant", async () => {
    await setup();
    const pending = await writePending(runDir, { requestId: "req-push", command: "git push origin HEAD" });
    const result = await dispatchOnce({ runDir, secret: SECRET, callback: grantRm });
    expect(result.granted).toEqual([]);
    expect(result.skipped).toEqual(["req-push"]);
    expect(existsSync(pendingApprovalPath(runDir, pending.requestId))).toBe(true);
    expect(existsSync(join(runDir, "approvals", "granted"))).toBe(false);
  });

  it("writes approvals/denied and does not mint when the callback refuses", async () => {
    await setup();
    const pending = await writePending(runDir, { requestId: "req-deny", command: "rm tmp/x" });
    const result = await dispatchOnce({
      runDir,
      secret: SECRET,
      callback: async () => ({ grant: false, reason: "judge said no" }),
    });
    expect(result.denied).toEqual(["req-deny"]);
    expect(existsSync(pendingApprovalPath(runDir, pending.requestId))).toBe(false);
    const denied = JSON.parse(await readFile(join(runDir, "approvals", "denied", "req-deny.json"), "utf8")) as {
      reason: string;
    };
    expect(denied.reason).toBe("judge said no");
    expect(existsSync(join(runDir, "approvals", "granted"))).toBe(false);
  });

  it("does not mint when the callback throws (fail-closed); pending remains", async () => {
    await setup();
    const pending = await writePending(runDir, { requestId: "req-err", command: "chmod +x a" });
    const result = await dispatchOnce({
      runDir,
      secret: SECRET,
      callback: async () => {
        throw new Error("judge crashed");
      },
    });
    expect(result.granted).toEqual([]);
    expect(result.denied).toEqual([]);
    expect(existsSync(pendingApprovalPath(runDir, pending.requestId))).toBe(true);
    expect(existsSync(join(runDir, "approvals", "granted"))).toBe(false);
  });
});

describe("registerApprovalDispatcher", () => {
  let runDir: string;
  afterEach(async () => {
    if (runDir !== undefined) await rm(runDir, { recursive: true, force: true });
  });

  it("polls pending files and stops without leaking grants after stop()", async () => {
    runDir = await mkdtemp(join(tmpdir(), "pi-sdlc-dispatch-poll-"));
    await writeFile(join(runDir, ".secret"), SECRET, { mode: 0o600 });
    await writePending(runDir, { requestId: "req-poll", command: "mv a b" });
    const seen: string[] = [];
    const dispatcher = registerApprovalDispatcher({
      runDir,
      secret: SECRET,
      pollMs: 20,
      callback: async (pending) => {
        seen.push(pending.requestId);
        return { grant: true, op: "bash", argsHash: hashArgs("bash", { command: pending.command }) };
      },
    });
    try {
      await expect.poll(() => readdir(join(runDir, "approvals", "granted")).then((n) => n.filter((x) => x.endsWith(".json")).length)).toBe(1);
      expect(seen).toContain("req-poll");
    } finally {
      await dispatcher.stop();
    }
    const afterStop = (await readdir(join(runDir, "approvals", "granted"))).filter((n) => n.endsWith(".json")).length;
    await writePending(runDir, { requestId: "req-late", command: "rm late" });
    await new Promise((r) => setTimeout(r, 80));
    const still = (await readdir(join(runDir, "approvals", "granted"))).filter((n) => n.endsWith(".json")).length;
    expect(still).toBe(afterStop);
    expect(existsSync(pendingApprovalPath(runDir, "req-late"))).toBe(true);
  });
});
