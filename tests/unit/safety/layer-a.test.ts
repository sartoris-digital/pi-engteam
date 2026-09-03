import { describe, expect, it } from "vitest";
import { controllerHardBlock, hardBlock } from "../../../src/safety/layer-a.js";
import { fakePathEnv, fakeRunContext } from "../../helpers/run-context.js";

const env = fakePathEnv();
const ctx = fakeRunContext();
const A = (tool: string, input: Record<string, unknown>, c = ctx) => hardBlock(tool, input, c, env);

describe("path-tool Layer A", () => {
  it("blocks protected paths and the main checkout, and allows the worktree", () => {
    const ssh = A("read", { path: "~/.ssh/id_ed25519" });
    expect(ssh?.layer).toBe("A");
    expect(ssh?.terminate).toBe(true);
    expect(ssh?.reason).toMatch(/^\[Layer A\]/);
    expect(A("write", { path: `${ctx.projectRoot}/src/a.ts`, content: "" })?.layer).toBe("A");
    expect(A("edit", { path: `${ctx.workspaceDir}/.git/config`, edits: [] })?.layer).toBe("A");
    expect(A("write", { path: `${ctx.runDir}/.secret`, content: "" })?.layer).toBe("A");
    expect(A("read", { path: `${ctx.workspaceDir}/src/a.ts` })).toBeNull();
    expect(A("read", {})).toBeNull();
  });

  it("opens the judge Layer D roots for the judge only", () => {
    const judge = fakeRunContext({ agent: "judge", stage: "judge" });
    expect(A("write", { path: `${judge.runDir}/approvals/x.json`, content: "" }, judge)).toBeNull();
    expect(A("write", { path: `${judge.runDir}/verdict.md`, content: "" }, judge)).toBeNull();
    expect(A("write", { path: `${judge.runDir}/.secret`, content: "" }, judge)?.layer).toBe("A");
    expect(A("write", { path: `${ctx.runDir}/approvals/x.json`, content: "" })?.layer).toBe("A");
  });
});

describe("command table", () => {
  it.each([
    "rm -rf /", "rm -rf ~", "git push --force origin main", "git push -f origin main",
    "sudo rm -rf /tmp", "npm publish", "launchctl load ~/Library/LaunchAgents/x.plist",
    "systemctl enable foo", "crontab -e", "dd if=/dev/zero of=/dev/sda", "mkfs.ext4 /dev/sda1",
    "cat ~/.pi/sdlc-factory/vault.sqlite", "echo x > ~/.ssh/authorized_keys",
  ])("terminates %s", (cmd) => {
    const block = A("bash", { command: cmd });
    expect(block?.layer, cmd).toBe("A");
    expect(block?.terminate, cmd).toBe(true);
  });

  it("does not take Layer C's job: relative rm and ordinary commits pass Layer A", () => {
    expect(A("bash", { command: "rm -rf build" })).toBeNull();
    expect(A("bash", { command: "git commit -m x" })).toBeNull();
    expect(A("bash", { command: "ls -la" })).toBeNull();
    expect(A("bash", {})).toBeNull();
  });
});

describe("controllerHardBlock", () => {
  it("blocks only the vault, keyring and factory-home paths and never terminates", () => {
    const vault = controllerHardBlock("read", { path: `${env.factoryHome}/vault.sqlite` }, env);
    expect(vault).toEqual({ block: true, layer: "A", reason: expect.stringMatching(/^\[Layer A\]/) });
    expect(vault?.terminate).toBeUndefined();
    expect(controllerHardBlock("bash", { command: "cat ~/.pi/sdlc-factory/runs/_factory/queue.json" }, env)?.block).toBe(true);
    expect(controllerHardBlock("read", { path: "~/Library/Keychains/login.keychain-db" }, env)?.block).toBe(true);
    expect(controllerHardBlock("bash", { command: "git push --force origin main" }, env)).toBeNull();
    expect(controllerHardBlock("bash", { command: "rm -rf /" }, env)).toBeNull();
    expect(controllerHardBlock("write", { path: "/repos/app/src/a.ts", content: "" }, env)).toBeNull();
  });
});
