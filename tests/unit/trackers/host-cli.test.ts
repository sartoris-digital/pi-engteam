import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeCli, createPathCli } from "../../../src/trackers/host-cli.js";
import { installStubPath } from "../../helpers/install-stub-path.js";

describe("createFakeCli", () => {
  it("returns canned stdout for the given argv", async () => {
    const cli = createFakeCli((argv) => ({
      stdout: JSON.stringify({ argv }),
      stderr: "",
      code: 0,
    }));
    const result = await cli.exec(["az", "account", "show"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ argv: ["az", "account", "show"] });
  });
});

describe("createPathCli", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it("runs stub az from PATH without touching the network", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "pi-sdlc-host-cli-")));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const installed = await installStubPath(home);
    const cli = createPathCli({
      ...installed.env,
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
    });
    const result = await cli.exec(["az", "account", "show"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: "sub", name: "Test" });
  });
});
