import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_DEVICES,
  JUDGE_AGENT,
  ORCH_OWNED,
  PROTECTED_HOME_PATTERNS,
  PROTECTED_SYSTEM_PREFIXES,
  expandHome,
  isProtectedPath,
  isUnder,
  realish,
  resolveToolPath,
} from "../../../src/safety/paths.js";
import { fakePathEnv, fakeRunContext } from "../../helpers/run-context.js";

const env = fakePathEnv();
const ctx = fakeRunContext();
const P = (p: string, c = ctx) => isProtectedPath(p, c, env);

describe("path helpers", () => {
  it("expands ~, matches descendants without prefix-colliding, and lists the spec sets", () => {
    expect(expandHome("~/x", "/Users/op")).toBe("/Users/op/x");
    expect(expandHome("~", "/Users/op")).toBe("/Users/op");
    expect(isUnder("/w/src/a.ts", "/w/src")).toBe(true);
    expect(isUnder("/w/src", "/w/src")).toBe(true);
    expect(isUnder("/w/srcx/a.ts", "/w/src")).toBe(false);
    expect(PROTECTED_SYSTEM_PREFIXES).toEqual(expect.arrayContaining(["/etc", "/usr", "/bin", "/sbin", "/boot", "/System"]));
    expect(PROTECTED_HOME_PATTERNS).toEqual(expect.arrayContaining([".ssh", ".aws", ".gnupg", ".config/gh", ".git-credentials", "Library/Keychains"]));
    expect(ORCH_OWNED).toEqual(expect.arrayContaining(["state.json", ".secret", "_verdicts", "approvals/pending", "evidence"]));
    expect(ALLOWED_DEVICES.has("/dev/null")).toBe(true);
    expect(JUDGE_AGENT).toBe("judge");
    expect(realish("/repos/app/src/a.ts")).toBe("/repos/app/src/a.ts");
    expect(resolveToolPath("src/a.ts", ctx, env)).toBe("/repos/app/src/a.ts");
  });
});

describe("isProtectedPath", () => {
  it("blocks system, home, factory-home and secret files", () => {
    expect(P("/etc/passwd").blocked).toBe(true);
    expect(P("/usr/bin/git").blocked).toBe(true);
    expect(P("~/.ssh/id_ed25519").blocked).toBe(true);
    expect(P(`${env.home}/.aws/credentials`).blocked).toBe(true);
    expect(P("~/Library/Keychains/login.keychain-db").blocked).toBe(true);
    expect(P("/Library/Keychains/x").blocked).toBe(true);
    expect(P(`${env.factoryHome}/vault.sqlite`).blocked).toBe(true);
    expect(P(`${env.factoryHome}/runs/_factory/queue.json`).blocked).toBe(true);
    expect(P("/tmp/id_rsa").blocked).toBe(true);
    expect(P("/repos/app/.env").blocked).toBe(true);
    expect(P("/repos/app/.env.sample").blocked).toBe(false);
    expect(P("/repos/app/src/a.ts").blocked).toBe(false);
  });

  it("blocks ORCH_OWNED under the run dir and opens the verdict slot plus judge roots", () => {
    expect(P(`${ctx.runDir}/state.json`).blocked).toBe(true);
    expect(P(`${ctx.runDir}/events.jsonl`).blocked).toBe(true);
    expect(P(`${ctx.runDir}/.secret`).blocked).toBe(true);
    expect(P(`${ctx.runDir}/approvals/pending/x.json`).blocked).toBe(true);
    expect(P(`${ctx.runDir}/approvals/granted/t.json`).blocked).toBe(true);
    expect(P(`${ctx.runDir}/evidence/stage-x.json`).blocked).toBe(true);
    const withVerdict = fakePathEnv({ verdictFile: `${ctx.runDir}/_verdicts/implement-r1.json` });
    expect(isProtectedPath(`${ctx.runDir}/_verdicts/implement-r1.json`, ctx, withVerdict).blocked).toBe(false);
    expect(isProtectedPath(`${ctx.runDir}/_verdicts/other.json`, ctx, withVerdict).blocked).toBe(true);
    const judge = fakeRunContext({ agent: "judge", stage: "judge" });
    expect(P(`${judge.runDir}/approvals/x.json`, judge).blocked).toBe(false);
    expect(P(`${judge.runDir}/verdict.md`, judge).blocked).toBe(false);
    expect(P(`${judge.runDir}/dependency-approval.json`, judge).blocked).toBe(false);
    expect(P(`${judge.runDir}/evidence/judge-1.json`, judge).blocked).toBe(false);
    expect(P(`${judge.runDir}/.secret`, judge).blocked).toBe(true);
    expect(P(`${judge.runDir}/approvals/pending/x.json`, judge).blocked).toBe(true);
    expect(P(`${ctx.runDir}/approvals/x.json`).blocked).toBe(true);
  });

  it("blocks the main checkout, .git, and sibling worktrees", () => {
    expect(P(`${ctx.projectRoot}/src/a.ts`).blocked).toBe(true);
    expect(P(`${ctx.workspaceDir}/.git/config`).blocked).toBe(true);
    expect(P(`${ctx.projectRoot}/.git/HEAD`).blocked).toBe(true);
    expect(P(`${env.factoryHome}/worktrees/app/other-ticket/src/a.ts`).blocked).toBe(true);
    expect(P(`${ctx.workspaceDir}/src/a.ts`).blocked).toBe(false);
  });

  it("protects vault, _factory, other runs and sibling worktrees when factoryHome is a symlink", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-sdlc-paths-link-"));
    try {
      const realFactory = join(tmp, "real-factory");
      const linkFactory = join(tmp, "link-factory");
      await mkdir(join(realFactory, "runs", "_factory"), { recursive: true });
      await mkdir(join(realFactory, "worktrees", "other-ticket"), { recursive: true });
      await writeFile(join(realFactory, "vault.sqlite"), "vault");
      await writeFile(join(realFactory, "runs", "_factory", "queue.json"), "{}");
      await writeFile(join(realFactory, "worktrees", "other-ticket", "src.ts"), "x");
      await symlink(realFactory, linkFactory);
      const linkedEnv = fakePathEnv({ home: join(tmp, "home"), factoryHome: linkFactory });
      const linkedCtx = fakeRunContext({
        workspaceDir: join(tmp, "ws"),
        projectRoot: join(tmp, "main"),
        runDir: join(tmp, "unrelated-run"),
        runsDir: join(tmp, "unrelated-runs"),
      });
      const Q = (p: string) => isProtectedPath(p, linkedCtx, linkedEnv);
      expect(Q(join(linkFactory, "vault.sqlite")).blocked).toBe(true);
      expect(Q(join(realFactory, "vault.sqlite")).blocked).toBe(true);
      expect(Q(join(linkFactory, "runs", "_factory", "queue.json")).blocked).toBe(true);
      expect(Q(join(realFactory, "runs", "run-other", "state.json")).blocked).toBe(true);
      expect(Q(join(linkFactory, "worktrees", "other-ticket", "src.ts")).blocked).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
