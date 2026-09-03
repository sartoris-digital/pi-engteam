import { describe, it, expect } from "vitest";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HeadlessExecutor } from "../../../src/runtime/headless.js";
import { runEnvScrubProbe } from "../../../src/runtime/env-scrub-probe.js";
import { withTmpHome } from "../../helpers/tmp-home.js";

const STUB = fileURLToPath(new URL("../../helpers/stub-pi-env.mjs", import.meta.url));

describe("runEnvScrubProbe", () => {
  it("reports no leaked GITHUB_TOKEN/GH_TOKEN/SSH_AUTH_SOCK through HeadlessExecutor", async () => {
    await chmod(STUB, 0o755);
    await withTmpHome(async (home) => {
      const executor = new HeadlessExecutor({
        sandbox: null,
        baseEnv: {
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          HOME: home,
          TMPDIR: tmpdir(),
          GITHUB_TOKEN: "leak",
          GH_TOKEN: "leak",
          SSH_AUTH_SOCK: "/tmp/sock",
          AZURE_CLIENT_SECRET: "az-leak",
          JIRA_API_TOKEN: "jira-leak",
        },
        pollMs: 20,
        killGraceMs: 500,
      });
      const { leaked } = await runEnvScrubProbe({ piBinary: STUB, executor, home });
      expect(leaked).toEqual([]);
    });
  }, 20_000);
});
