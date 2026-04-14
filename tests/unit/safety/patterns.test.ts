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
