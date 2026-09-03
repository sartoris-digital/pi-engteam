import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activate_default, { activate, selectMode } from "../../src/index.js";
import { registerController } from "../../src/controller/index.js";
import { FakePi } from "../helpers/fake-pi.js";
import { withTmpHome } from "../helpers/tmp-home.js";

describe("extension entry", () => {
  let root: string;
  let workerEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-sdlc-entry-"));
    const policyFile = join(root, "policy.yaml");
    await writeFile(policyFile, "agents: {}\n");
    await mkdir(join(root, "runs", "run-i1"), { recursive: true });
    workerEnv = {
      PI_SDLC_AGENT_MODE: "1",
      PI_SDLC_RUN_ID: "run-i1",
      PI_SDLC_RUNS_DIR: join(root, "runs"),
      PI_SDLC_STEP: "plan",
      PI_SDLC_AGENT: "planner",
      PI_SDLC_VERDICT_FILE: join(root, "runs", "run-i1", "_verdicts", "plan-r1.json"),
      PI_SDLC_WORKSPACE_DIR: root,
      PI_SDLC_PROJECT_ROOT: root,
      PI_SDLC_POLICY_FILE: policyFile,
      PI_SDLC_POLICY_SHA: createHash("sha256").update(await readFile(policyFile)).digest("hex"),
      PI_SDLC_EXTRA_UPSERT: "[]",
      PI_SDLC_DENY_UPSERT: "[]",
      PI_SDLC_NONCE: "n",
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("selectMode", () => {
    it("is controller without PI_SDLC_AGENT_MODE", () => {
      expect(selectMode({})).toBe("controller");
      expect(selectMode({ PI_SDLC_RUN_ID: "run-i1" })).toBe("controller");
    });

    it("is controller when agent mode is set but the run context is absent or partial", () => {
      expect(selectMode({ PI_SDLC_AGENT_MODE: "1" })).toBe("controller");
      expect(selectMode({ ...workerEnv, PI_SDLC_RUN_ID: undefined })).toBe("controller");
    });

    it("is worker with agent mode and a complete run context", () => {
      expect(selectMode(workerEnv)).toBe("worker");
    });

    it("is worker (never controller) when a present run context is malformed", () => {
      expect(selectMode({ ...workerEnv, PI_SDLC_EXTRA_UPSERT: "{not json" })).toBe("worker");
    });
  });

  describe("activate", () => {
    it("registers the worker tools in agent mode", async () => {
      const fake = new FakePi();
      expect(await activate(fake.asPi(), workerEnv)).toBe("worker");
      expect(fake.hasTool("VerdictEmit")).toBe(true);
      expect(fake.hasTool("RequestApproval")).toBe(true);
    });

    it("registers no worker tools in controller mode", async () => {
      const fake = new FakePi();
      await withTmpHome(async () => {
        expect(await activate(fake.asPi(), { HOME: root })).toBe("controller");
      });
      expect(fake.hasTool("VerdictEmit")).toBe(false);
      expect(fake.hasTool("RequestApproval")).toBe(false);
    });

    it("exports the extension factory as default and the controller is callable", async () => {
      expect(typeof activate_default).toBe("function");
      const fake = new FakePi();
      await withTmpHome(async () => {
        await registerController(fake.asPi());
      });
      expect(fake.commands.has("factory")).toBe(true);
    });
  });
});
