import { describe, it, expect } from "vitest";
import {
  isDangerousRm,
  isEnvFileAccess,
  isForcePush,
  isSudo,
  isPublish,
} from "../../../src/safety/patterns.js";
import { isProtectedPath, expandPath } from "../../../src/safety/paths.js";

describe("isDangerousRm", () => {
  it("blocks rm -rf /", () => expect(isDangerousRm("rm -rf /")).toBe(true));
  it("blocks rm -rf ~", () => expect(isDangerousRm("rm -rf ~")).toBe(true));
  it("blocks rm -rf *", () => expect(isDangerousRm("rm -rf *")).toBe(true));
  it("blocks rm -rf ./", () => expect(isDangerousRm("rm -rf ./")).toBe(true));
  it("blocks rm -rf $HOME", () => expect(isDangerousRm("rm -rf $HOME")).toBe(true));
  it("allows rm old-file.txt", () => expect(isDangerousRm("rm old-file.txt")).toBe(false));
  it("allows rm -f build/output.js", () => expect(isDangerousRm("rm -f build/output.js")).toBe(false));
});

describe("isEnvFileAccess", () => {
  it("blocks .env", () => expect(isEnvFileAccess(".env")).toBe(true));
  it("blocks .env.local", () => expect(isEnvFileAccess(".env.local")).toBe(true));
  it("blocks .env.production", () => expect(isEnvFileAccess(".env.production")).toBe(true));
  it("allows .env.sample", () => expect(isEnvFileAccess(".env.sample")).toBe(false));
  it("allows .env.example", () => expect(isEnvFileAccess(".env.example")).toBe(false));
});

describe("isProtectedPath", () => {
  it("blocks /etc/hosts", () => expect(isProtectedPath("/etc/hosts").blocked).toBe(true));
  it("blocks /usr/local/bin/foo", () => expect(isProtectedPath("/usr/local/bin/foo").blocked).toBe(true));
  it("blocks ~/.ssh/id_rsa", () =>
    expect(isProtectedPath(expandPath("~/.ssh/id_rsa")).blocked).toBe(true));
  it("blocks ~/.aws/credentials", () =>
    expect(isProtectedPath(expandPath("~/.aws/credentials")).blocked).toBe(true));
  it("allows a normal project path", () =>
    expect(isProtectedPath("/home/user/projects/myapp/src/index.ts").blocked).toBe(false));
  // Phase 5 round-1 C1: single-writer policy enforcement on expertise files.
  it("blocks user-global expertise file writes (Phase 5 §8.3)", () =>
    expect(isProtectedPath(expandPath("~/.pi/engineering-team/expertise/engineer.md")).blocked).toBe(true));
  it("blocks project-local expertise file writes (Phase 5 §8.3)", () =>
    expect(isProtectedPath("/home/user/proj/.pi/engineering-team/expertise/eng.md").blocked).toBe(true));
  it("blocks _readonly subdir writes (Phase 5 §8.5)", () =>
    expect(isProtectedPath("/home/user/proj/.pi/engineering-team/expertise/_readonly/billing.md").blocked).toBe(true));

  // Phase A item 9 + round 2 HIGH #1: orchestrator-owned paths under runDir.
  describe("Phase A: orchestrator-owned paths under runDir", () => {
    const runsDir = "/home/user/.pi/engineering-team/runs";
    it("blocks state.json", () => {
      expect(isProtectedPath(`${runsDir}/abc/state.json`, { runsDir }).blocked).toBe(true);
    });
    it("blocks events.jsonl", () => {
      expect(isProtectedPath(`${runsDir}/abc/events.jsonl`, { runsDir }).blocked).toBe(true);
    });
    it("blocks conversation.jsonl", () => {
      expect(isProtectedPath(`${runsDir}/abc/conversation.jsonl`, { runsDir }).blocked).toBe(true);
    });
    it("blocks agent-activity.jsonl", () => {
      expect(isProtectedPath(`${runsDir}/abc/agent-activity.jsonl`, { runsDir }).blocked).toBe(true);
    });
    it("blocks feature-decisions.json (round 15 HIGH #3)", () => {
      expect(isProtectedPath(`${runsDir}/abc/feature-decisions.json`, { runsDir }).blocked).toBe(true);
    });
    it("blocks _verdicts/ subtree (round 2 HIGH #2)", () => {
      expect(isProtectedPath(`${runsDir}/abc/_verdicts/foo.json`, { runsDir }).blocked).toBe(true);
    });
    it("blocks _telemetry/ subtree", () => {
      expect(isProtectedPath(`${runsDir}/abc/_telemetry/fallbacks.jsonl`, { runsDir }).blocked).toBe(true);
    });
    it("blocks _activity/ subtree (round 4 MED #4)", () => {
      expect(isProtectedPath(`${runsDir}/_activity/abc/agent-activity.jsonl`, { runsDir }).blocked).toBe(true);
    });
    it("allows a normal artifact file under runDir", () => {
      expect(isProtectedPath(`${runsDir}/abc/triage-summary.md`, { runsDir }).blocked).toBe(false);
    });
  });
});

describe("isForcePush", () => {
  it("blocks git push --force origin main", () =>
    expect(isForcePush("git push --force origin main")).toBe(true));
  it("blocks git push -f", () => expect(isForcePush("git push -f")).toBe(true));
  it("blocks git push --force-with-lease", () =>
    expect(isForcePush("git push --force-with-lease")).toBe(true));
  it("allows git push origin main", () =>
    expect(isForcePush("git push origin main")).toBe(false));
});

describe("isSudo", () => {
  it("blocks sudo apt install vim", () =>
    expect(isSudo("sudo apt install vim")).toBe(true));
});

describe("isPublish", () => {
  it("blocks npm publish", () => expect(isPublish("npm publish")).toBe(true));
  it("blocks pnpm publish", () => expect(isPublish("pnpm publish")).toBe(true));
});
