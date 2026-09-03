import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installStubPath } from "../../helpers/install-stub-path.js";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { env, encoding: "utf8" }, (error, stdout, stderr) => {
      const e = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
      const code = e === null ? 0 : typeof e.code === "number" ? e.code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

async function harness(): Promise<{ home: string; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pi-sdlc-stub-cli-")));
  const installed = await installStubPath(home);
  const env: NodeJS.ProcessEnv = {
    PATH: installed.env.PATH,
    PI_SDLC_STUB_DIR: installed.env.PI_SDLC_STUB_DIR,
    PI_SDLC_HOME: home,
    HOME: home,
  };
  return {
    home,
    env,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

describe("installStubPath", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it("puts executable az and jira on PATH that serve fixtures and log argv", async () => {
    const h = await harness();
    cleanups.push(h.cleanup);

    const azBin = join(h.home, "bin", "az");
    const jiraBin = join(h.home, "bin", "jira");
    expect((await stat(azBin)).mode & 0o111).toBeTruthy();
    expect((await stat(jiraBin)).mode & 0o111).toBeTruthy();

    const az = await run("az", ["account", "show"], h.env);
    expect(az.code).toBe(0);
    expect(JSON.parse(az.stdout)).toEqual({ id: "sub", name: "Test" });

    const jira = await run("jira", ["me"], h.env);
    expect(jira.code).toBe(0);
    expect(JSON.parse(jira.stdout)).toMatchObject({
      accountId: "ada",
      emailAddress: "ada@example.com",
    });

    const logPath = join(h.env.PI_SDLC_STUB_DIR!, "_log.jsonl");
    const lines = (await readFile(logPath, "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { cli: string; argv: string[]; at: string });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ cli: "az", argv: ["account", "show"] });
    expect(lines[1]).toMatchObject({ cli: "jira", argv: ["me"] });
    expect(lines[0]?.at).toMatch(/^\d{4}-/);
  });

  it("exits 2 with a stub: no fixture message for unknown argv", async () => {
    const h = await harness();
    cleanups.push(h.cleanup);
    const result = await run("az", ["boards", "nope"], h.env);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/stub: no fixture for/);
  });

  it("fail-auth makes az account show and jira me exit 1", async () => {
    const h = await harness();
    cleanups.push(h.cleanup);
    const env = { ...h.env, PI_SDLC_STUB_SCENARIO: "fail-auth" };
    const az = await run("az", ["account", "show"], env);
    expect(az.code).toBe(1);
    const jira = await run("jira", ["me"], env);
    expect(jira.code).toBe(1);
  });

  it("does not open sockets when HTTP_PROXY points at a closed port", async () => {
    const h = await harness();
    cleanups.push(h.cleanup);
    const env = {
      ...h.env,
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      http_proxy: "http://127.0.0.1:1",
      https_proxy: "http://127.0.0.1:1",
    };
    const az = await run("az", ["account", "show"], env);
    expect(az.code).toBe(0);
    expect(JSON.parse(az.stdout)).toEqual({ id: "sub", name: "Test" });
    const item = await run("az", ["boards", "work-item", "show", "--id", "42", "--expand", "all", "-o", "json"], env);
    expect(item.code).toBe(0);
    expect(JSON.parse(item.stdout)).toMatchObject({ id: 42 });
  });
});
