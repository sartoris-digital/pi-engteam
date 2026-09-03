import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../../../src/safety/context.js";
import {
  EMPTY_POLICY,
  domainBlock,
  globToRegExp,
  loadDomainPolicy,
  matchesRoot,
  parsePolicyFile,
  policyForAgent,
  resolvePolicy,
  type DomainPolicy,
} from "../../../src/safety/layer-d.js";
import { fakePathEnv, fakeRunContext } from "../../helpers/run-context.js";

const env = fakePathEnv();

const POLICY_YAML = [
  "schemaVersion: 1",
  "agents:",
  "  implementer:",
  '    upsert: ["src/", "package.json"]',
  '    delete: ["src/"]',
  '    deny: ["tests/**"]',
  "    bash: full",
  "  tester:",
  '    upsert: ["tests/", "${RUN_DIR}/notes/"]',
  "    bash: full",
  "  planner:",
  '    upsert: ["${RUN_DIR}/plan.md"]',
  "    bash: read-only",
  "  reviewer:",
  '    read: ["src/", "${RUN_DIR}"]',
  '    upsert: ["${RUN_DIR}/review.md"]',
  "    bash: read-only",
  "  judge:",
  '    upsert: ["${RUN_DIR}/approvals/", "${RUN_DIR}/verdict.md", "${RUN_DIR}/dependency-approval.json", "${RUN_DIR}/evidence/judge-*.json"]',
  "    bash: read-only",
  "  issue-analyst:",
  '    upsert: ["${RUN_DIR}/brief.*"]',
  "    bash: none",
  "",
].join("\n");

const FILE = parsePolicyFile(POLICY_YAML);
const policyFor = (agent: string): DomainPolicy => policyForAgent(FILE, agent);
const D = (tool: string, input: Record<string, unknown>, c: RunContext, policy: DomainPolicy = policyFor(c.agent)) =>
  domainBlock(tool, input, c, policy, env);

describe("parsePolicyFile / policyForAgent", () => {
  it("parses the built-in shape and maps entries to DomainPolicy", () => {
    expect(policyFor("implementer")).toEqual({ readRoots: [], upsertRoots: ["src/", "package.json"], deleteRoots: ["src/"], denyUpsert: ["tests/**"], bashPolicy: "full" });
    expect(policyFor("judge").upsertRoots).toEqual([
      "${RUN_DIR}/approvals/", "${RUN_DIR}/verdict.md", "${RUN_DIR}/dependency-approval.json", "${RUN_DIR}/evidence/judge-*.json",
    ]);
    expect(policyFor("nobody")).toEqual(EMPTY_POLICY);
    expect(EMPTY_POLICY.bashPolicy).toBe("none");
  });

  it("tolerates a leading marker line and rejects malformed files", () => {
    expect(parsePolicyFile(`<!-- pi-sdlc-factory generated · run x · do not commit -->\n${POLICY_YAML}`).agents.judge?.bash).toBe("read-only");
    expect(() => parsePolicyFile("schemaVersion: 2\nagents: {}")).toThrow(/schemaVersion/);
    expect(() => parsePolicyFile("schemaVersion: 1")).toThrow(/agents/);
    expect(() => parsePolicyFile("schemaVersion: 1\nagents:\n  x:\n    bash: sometimes")).toThrow(/bash/);
    expect(() => parsePolicyFile("schemaVersion: 1\nagents:\n  x:\n    upsert: src/")).toThrow(/upsert/);
    expect(() => parsePolicyFile("- a\n- b")).toThrow(/mapping/);
  });
});

describe("loadDomainPolicy", () => {
  it("verifies the sha256 of the file and returns the agent's policy", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-sdlc-policy-"));
    try {
      const file = join(tmp, "policy.yaml");
      await writeFile(file, POLICY_YAML);
      const sha = createHash("sha256").update(POLICY_YAML).digest("hex");
      expect(loadDomainPolicy(file, sha, "planner")).toEqual({ readRoots: [], upsertRoots: ["${RUN_DIR}/plan.md"], deleteRoots: [], denyUpsert: [], bashPolicy: "read-only" });
      expect(loadDomainPolicy(file, sha, "nobody")).toEqual(EMPTY_POLICY);
      expect(() => loadDomainPolicy(file, "0".repeat(64), "planner")).toThrow(/sha256/);
      expect(() => loadDomainPolicy(join(tmp, "missing.yaml"), sha, "planner")).toThrow();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolvePolicy / matchesRoot", () => {
  const ctx = fakeRunContext({ extraUpsert: ["docs/**"], denyUpsert: ["migrations/**"] });

  it("re-anchors relative roots to the worktree, keeps ${RUN_DIR} absolute and merges the env lists", () => {
    const resolved = resolvePolicy(policyFor("tester"), ctx);
    expect(resolved.upsertRoots).toEqual([`${ctx.workspaceDir}/tests`, `${ctx.runDir}/notes`, `${ctx.workspaceDir}/docs/**`]);
    expect(resolved.denyUpsert).toEqual([`${ctx.workspaceDir}/migrations/**`]);
    expect(resolvePolicy({ ...EMPTY_POLICY, upsertRoots: ["${RUN_DIR}/x/${RUN_ID}.md"] }, ctx).upsertRoots).toEqual([
      `${ctx.runDir}/x/run-0001.md`,
      `${ctx.workspaceDir}/docs/**`,
    ]);
  });

  it("refuses unknown placeholders and ~", () => {
    expect(() => resolvePolicy({ ...EMPTY_POLICY, upsertRoots: ["${OTHER}/x"] }, ctx)).toThrow(/placeholder/);
    expect(() => resolvePolicy({ ...EMPTY_POLICY, readRoots: ["~/x"] }, ctx)).toThrow(/~/);
  });

  it("matches plain roots by prefix and glob roots on the path or any ancestor", () => {
    expect(matchesRoot("/w/src/a.ts", "/w/src")).toBe(true);
    expect(matchesRoot("/w/src", "/w/src")).toBe(true);
    expect(matchesRoot("/w/srcx/a.ts", "/w/src")).toBe(false);
    expect(matchesRoot("/w/packages/a/src/x.ts", "/w/packages/*/src")).toBe(true);
    expect(matchesRoot("/w/packages/a/lib/x.ts", "/w/packages/*/src")).toBe(false);
    expect(matchesRoot("/w/migrations/x/y.sql", "/w/migrations/**")).toBe(true);
    expect(matchesRoot("/w/migrations", "/w/migrations/**")).toBe(false);
    expect(matchesRoot("/r/evidence/judge-1.json", "/r/evidence/judge-*.json")).toBe(true);
    expect(matchesRoot("/r/evidence/judge-1/x.json", "/r/evidence/judge-*.json")).toBe(false);
    expect(matchesRoot("/r/evidence/stage.json", "/r/evidence/judge-*.json")).toBe(false);
    expect(matchesRoot("/r/brief.json", "/r/brief.*")).toBe(true);
    expect(globToRegExp("/a/**/b.?s").test("/a/x/y/b.ts")).toBe(true);
    expect(globToRegExp("/a/**/b.?s").test("/a/b.ts")).toBe(true);
    expect(globToRegExp("/a/*.ts").test("/a/b/c.ts")).toBe(false);
  });
});

describe("domainBlock: write/edit", () => {
  const implementer = fakeRunContext({ extraUpsert: ["docs/**"], denyUpsert: ["migrations/**"] });

  it("allows upsert roots, denies denyUpsert first, blocks everything else", () => {
    expect(D("write", { path: "src/a.ts", content: "" }, implementer)).toBeNull();
    expect(D("edit", { path: `${implementer.workspaceDir}/src/deep/b.ts`, edits: [] }, implementer)).toBeNull();
    expect(D("write", { path: "package.json", content: "" }, implementer)).toBeNull();
    expect(D("write", { path: "docs/x.md", content: "" }, implementer)).toBeNull();
    expect(D("write", { path: "tests/a.test.ts", content: "" }, implementer)?.reason).toMatch(/^\[Layer D\].*denied/);
    expect(D("write", { path: "migrations/001.sql", content: "" }, implementer)?.reason).toMatch(/denied/);
    const outside = D("write", { path: "lib/b.ts", content: "" }, implementer);
    expect(outside?.layer).toBe("D");
    expect(outside?.terminate).toBeUndefined();
    expect(outside?.reason).toMatch(/outside implementer's upsert roots/);
    expect(D("write", { path: "/elsewhere/src/a.ts", content: "" }, implementer)?.layer).toBe("D");
    expect(D("write", { path: `${implementer.runDir}/plan.md`, content: "" }, implementer)?.layer).toBe("D");
    expect(D("write", { path: "src/../lib/x.ts", content: "" }, implementer)?.reason).toMatch(/\.\./);
    expect(D("write", { path: "src/$NAME.ts", content: "" }, implementer)?.reason).toMatch(/unresolved/);
    expect(D("write", { content: "" }, implementer)?.layer).toBe("D");
  });

  it("pins the planner and the judge to their run-dir artifacts", () => {
    const planner = fakeRunContext({ agent: "planner", stage: "plan" });
    expect(D("write", { path: `${planner.runDir}/plan.md`, content: "" }, planner)).toBeNull();
    expect(D("write", { path: `${planner.runDir}/other.md`, content: "" }, planner)?.layer).toBe("D");
    expect(D("write", { path: "src/a.ts", content: "" }, planner)?.layer).toBe("D");
    const judge = fakeRunContext({ agent: "judge", stage: "judge" });
    for (const p of [`${judge.runDir}/approvals/x.json`, `${judge.runDir}/verdict.md`, `${judge.runDir}/dependency-approval.json`, `${judge.runDir}/evidence/judge-1.json`]) {
      expect(D("write", { path: p, content: "" }, judge), p).toBeNull();
    }
    for (const p of [`${judge.runDir}/evidence/stage-x.json`, `${judge.runDir}/plan.md`, `${judge.workspaceDir}/src/a.ts`, `${judge.runDir}/evidence/judge-1/x.json`]) {
      expect(D("write", { path: p, content: "" }, judge)?.layer, p).toBe("D");
    }
    const analyst = fakeRunContext({ agent: "issue-analyst", stage: "intake" });
    expect(D("write", { path: `${analyst.runDir}/brief.json`, content: "" }, analyst)).toBeNull();
    expect(D("write", { path: `${analyst.runDir}/brief.md`, content: "" }, analyst)).toBeNull();
    expect(D("write", { path: `${analyst.runDir}/plan.md`, content: "" }, analyst)?.layer).toBe("D");
  });

  it("blocks with a clear message when the policy refuses to apply", () => {
    const bad: DomainPolicy = { ...EMPTY_POLICY, upsertRoots: ["${OTHER}/x"], bashPolicy: "full" };
    expect(D("write", { path: "src/a.ts", content: "" }, implementer, bad)?.reason).toMatch(/refused to apply.*placeholder/);
    expect(D("read", { path: "src/a.ts" }, implementer, bad)?.reason).toMatch(/refused to apply/);
  });
});

describe("domainBlock: reads", () => {
  it("is unrestricted with empty readRoots and enforced otherwise", () => {
    const implementer = fakeRunContext();
    expect(D("read", { path: "/anywhere/x" }, implementer)).toBeNull();
    const reviewer = fakeRunContext({ agent: "reviewer", stage: "review" });
    expect(D("read", { path: "src/a.ts" }, reviewer)).toBeNull();
    expect(D("grep", { path: `${reviewer.runDir}/plan.md`, pattern: "x" }, reviewer)).toBeNull();
    expect(D("read", { path: "lib/a.ts" }, reviewer)?.reason).toMatch(/may not read/);
    expect(D("ls", {}, reviewer)).toBeNull();
    expect(D("find", { path: "src/../lib" }, reviewer)?.layer).toBe("D");
  });
});

describe("domainBlock: bash", () => {
  const implementer = fakeRunContext();
  const bash = (command: string, c: RunContext, policy?: DomainPolicy) => D("bash", { command }, c, policy);

  it("none blocks everything; read-only requires a safe classification", () => {
    const analyst = fakeRunContext({ agent: "issue-analyst", stage: "intake" });
    expect(bash("ls", analyst)?.reason).toMatch(/has no bash/);
    const reviewer = fakeRunContext({ agent: "reviewer", stage: "review" });
    expect(bash("git status && cat src/a.ts", reviewer)).toBeNull();
    expect(bash("git commit -m x", reviewer)?.reason).toMatch(/read-only/);
    expect(bash("echo x > /dev/null", reviewer)).toBeNull();
  });

  it("full checks redirect, tee and rm targets against the roots", () => {
    expect(bash("echo x > src/a.ts", implementer)).toBeNull();
    expect(bash("cat a >> src/log.txt", implementer)).toBeNull();
    expect(bash("echo x > /dev/null", implementer)).toBeNull();
    expect(bash("echo x > lib/a.ts", implementer)?.layer).toBe("D");
    expect(bash("echo x > tests/a.test.ts", implementer)?.reason).toMatch(/denied/);
    expect(bash("ls | tee src/out.txt", implementer)).toBeNull();
    expect(bash("ls | tee lib/out.txt", implementer)?.layer).toBe("D");
    expect(bash("ls | tee -a tests/x", implementer)?.reason).toMatch(/denied/);
    expect(bash("rm src/a.ts", implementer)).toBeNull();
    expect(bash("rm -r lib/a.ts", implementer)?.reason).toMatch(/delete roots/);
    expect(bash("echo x > $OUT", implementer)?.reason).toMatch(/unresolved/);
    expect(bash("git status; echo x > lib/a.ts", implementer)?.layer).toBe("D");
    expect(bash("git commit -m x", implementer)).toBeNull();
    expect(bash("rm x", implementer, { ...EMPTY_POLICY, upsertRoots: ["."], bashPolicy: "full" })?.reason).toMatch(/delete roots/);
    expect(D("bash", {}, implementer)?.layer).toBe("D");
  });

  it("ignores other tools", () => {
    expect(D("VerdictEmit", { step: "x" }, implementer)).toBeNull();
  });
});
