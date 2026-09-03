import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prepareRunSandbox, runSandboxModes } from "../../../src/controller/lane-runner.js";
import { makeRepoConfig } from "../../helpers/steer-fixtures.js";

describe("prepareRunSandbox", () => {
  beforeEach(() => {
    runSandboxModes.clear();
  });
  afterEach(() => {
    runSandboxModes.clear();
  });

  it("skips the probe when sandbox is off and records the mode", async () => {
    const result = await prepareRunSandbox("run-off", makeRepoConfig({ sandbox: "off" }));
    expect(result).toEqual({ ok: true });
    expect(runSandboxModes.get("run-off")).toBe("off");
  });

  it("escalates env-setup-failed when sandbox is required and the probe is forced unavailable", async () => {
    const result = await prepareRunSandbox("run-req", makeRepoConfig({ sandbox: "required" }), {
      probe: async () => ({ available: false, provider: null, detail: "no provider" }),
    });
    expect(result).toEqual({
      ok: false,
      escalate: "env-setup-failed",
      detail: "no provider",
    });
  });
});
