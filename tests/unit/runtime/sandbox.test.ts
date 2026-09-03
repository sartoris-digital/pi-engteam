import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HERDR_SOCKET,
  PROTECTED_READ_DENY,
  SandboxUnavailableError,
  probeSandbox,
  profileForRequest,
  renderBwrapArgs,
  renderSeatbeltProfile,
  worktreeGitDir,
  wrapArgv,
  type SandboxProfile,
} from "../../../src/runtime/sandbox.js";
import { makeWorkerRequest } from "../../helpers/worker-request.js";

const MARKER = "<!-- pi-sdlc-factory generated · run run-sb · do not commit -->";

describe("sandbox", () => {
  let root: string;
  let profile: SandboxProfile;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-sdlc-sandbox-"));
    const workspaceDir = join(root, "ws");
    const runDir = join(root, "runs", "run-sb");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await mkdir(join(root, "home", ".config", "gh"), { recursive: true });
    await mkdir(join(root, "home", ".config", "jira-cli"), { recursive: true });
    await writeFile(join(root, "home", ".npmrc"), "//registry/:_authToken=leak\n");
    profile = {
      workspaceDir,
      runDir,
      allowWrite: [workspaceDir, runDir, join(root, "tmp-missing")],
      denyRead: [join(root, "home", ".config", "gh"), join(root, "home", ".npmrc"), join(root, "home", ".config", "jira*")],
      denyUnixSockets: [join(root, "home", ".config", "herdr", "herdr.sock")],
      network: "allow",
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("renderSeatbeltProfile", () => {
    it("starts with the marker as a Scheme comment and denies writes by default", () => {
      const text = renderSeatbeltProfile(profile, "run-sb");
      const lines = text.split("\n");
      expect(lines[0]).toBe(`;; ${MARKER}`);
      expect(lines[1]).toBe("(version 1)");
      expect(lines[2]).toBe("(allow default)");
      expect(lines[3]).toBe("(deny file-write*)");
      expect(text).toContain('(allow file-write* (literal "/dev/null")');
    });

    it("allows writes only under the listed roots and denies the protected reads", () => {
      const text = renderSeatbeltProfile(profile, "run-sb");
      expect(text).toContain(`(allow file-write* (subpath "${profile.workspaceDir}"))`);
      expect(text).toContain(`(allow file-write* (subpath "${profile.runDir}"))`);
      expect(text).toContain(`(allow file-write* (subpath "${join(root, "tmp-missing")}"))`);
      expect(text).toContain(`(deny file-read* (subpath "${join(root, "home", ".config", "gh")}"))`);
      expect(text).toContain(`(deny file-read* (subpath "${join(root, "home", ".npmrc")}"))`);
      expect(text).toContain(`(deny file-read* (regex #"^${join(root, "home", ".config", "jira").replace(/\./g, "\\.")}"))`);
      expect(text).toContain(`(deny network-outbound (literal "${join(root, "home", ".config", "herdr", "herdr.sock")}"))`);
      expect(text).not.toContain("(deny network*)");
    });

    it("denies all networking when the profile says so", () => {
      expect(renderSeatbeltProfile({ ...profile, network: "deny" }, "run-sb")).toContain("(deny network*)");
    });
  });

  describe("renderBwrapArgs", () => {
    it("binds writable roots, hides denied paths and ends with --", () => {
      const args = renderBwrapArgs(profile);
      expect(args[0]).toBe("bwrap");
      expect(args).toContain("--die-with-parent");
      expect(args.join(" ")).toContain(`--bind ${profile.workspaceDir} ${profile.workspaceDir}`);
      expect(args.join(" ")).not.toContain("tmp-missing");
      expect(args.join(" ")).toContain(`--tmpfs ${join(root, "home", ".config", "gh")}`);
      expect(args.join(" ")).toContain(`--tmpfs ${join(root, "home", ".config", "jira-cli")}`);
      expect(args.join(" ")).toContain(`--ro-bind /dev/null ${join(root, "home", ".npmrc")}`);
      expect(args).not.toContain("--unshare-net");
      expect(args[args.length - 1]).toBe("--");
    });

    it("adds --unshare-net when the network is denied", () => {
      expect(renderBwrapArgs({ ...profile, network: "deny" })).toContain("--unshare-net");
    });
  });

  describe("wrapArgv", () => {
    it("on darwin writes sandbox.sb into the run dir and prefixes sandbox-exec", async () => {
      const wrapped = wrapArgv(["pi", "-p"], profile, { platform: "darwin" });
      const sb = join(profile.runDir, "sandbox.sb");
      expect(wrapped).toEqual(["sandbox-exec", "-f", sb, "pi", "-p"]);
      const text = await readFile(sb, "utf8");
      expect(text.split("\n")[0]).toBe(`;; ${MARKER}`);
    });

    it("on linux writes sandbox.bwrap (marker first) and prefixes the bwrap args", async () => {
      const wrapped = wrapArgv(["pi", "-p"], profile, { platform: "linux" });
      expect(wrapped[0]).toBe("bwrap");
      expect(wrapped.slice(-3)).toEqual(["--", "pi", "-p"]);
      const lines = (await readFile(join(profile.runDir, "sandbox.bwrap"), "utf8")).split("\n");
      expect(lines[0]).toBe(MARKER);
      expect(lines.slice(1).filter((l) => l.length > 0)).toEqual(renderBwrapArgs(profile));
    });

    it("throws SandboxUnavailableError elsewhere", () => {
      expect(() => wrapArgv(["pi"], profile, { platform: "win32" })).toThrow(SandboxUnavailableError);
    });
  });

  describe("probeSandbox", () => {
    async function fakeBin(name: string, body: string): Promise<string> {
      const bin = join(root, "bin");
      await mkdir(bin, { recursive: true });
      const path = join(bin, name);
      await writeFile(path, body);
      await chmod(path, 0o755);
      return bin;
    }

    it("reports sandbox-exec available when the wrapper runs true", async () => {
      const bin = await fakeBin("sandbox-exec", '#!/bin/sh\n[ "$1" = "-f" ] || exit 2\n[ -f "$2" ] || exit 3\nshift 2\nexec "$@"\n');
      const probe = await probeSandbox({ platform: "darwin", env: { PATH: `${bin}:/usr/bin:/bin` }, tmpRoot: root });
      expect(probe).toEqual({ available: true, provider: "sandbox-exec", detail: expect.stringContaining("sandbox-exec ran") });
    });

    it("reports bwrap available when the wrapper runs true", async () => {
      const bin = await fakeBin("bwrap", '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
      const probe = await probeSandbox({ platform: "linux", env: { PATH: `${bin}:/usr/bin:/bin` }, tmpRoot: root });
      expect(probe.available).toBe(true);
      expect(probe.provider).toBe("bwrap");
    });

    it("reports unavailable with a reason when the provider binary is missing", async () => {
      const probe = await probeSandbox({ platform: "darwin", env: { PATH: join(root, "empty-bin") }, tmpRoot: root });
      expect(probe.available).toBe(false);
      expect(probe.provider).toBe("sandbox-exec");
      expect(probe.detail).toMatch(/not found on PATH/);
    });

    it("reports no provider on unsupported platforms", async () => {
      const probe = await probeSandbox({ platform: "win32", tmpRoot: root });
      expect(probe).toEqual({ available: false, provider: null, detail: expect.stringContaining("win32") });
    });
  });

  describe("profileForRequest", () => {
    it("builds the spec §5.8 profile for a worker request", async () => {
      const home = join(root, "home");
      const ws = join(root, "wt");
      await mkdir(ws, { recursive: true });
      await writeFile(join(ws, ".git"), `gitdir: ${join(root, "main", ".git", "worktrees", "wt")}\n`);
      const req = makeWorkerRequest({ cwd: ws, runDir: profile.runDir });
      const p = profileForRequest(req, { home, tmpDir: join(root, "tmp") });
      expect(p.workspaceDir).toBe(ws);
      expect(p.runDir).toBe(profile.runDir);
      expect(p.allowWrite).toEqual([ws, profile.runDir, join(root, "tmp"), join(root, "main", ".git", "worktrees", "wt")]);
      expect(p.denyRead).toEqual(PROTECTED_READ_DENY.map((rel) => join(home, rel)));
      expect(p.denyUnixSockets).toEqual([join(home, HERDR_SOCKET)]);
      expect(p.network).toBe("allow");
    });

    it("omits the git dir when the workspace has no .git pointer file", () => {
      expect(worktreeGitDir(join(root, "nope"))).toBeNull();
      const p = profileForRequest(makeWorkerRequest({ cwd: join(root, "nope") }), { home: root, tmpDir: root });
      expect(p.allowWrite).toHaveLength(3);
    });
  });
});
