import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorkerEnv,
  createScrubDirs,
  verdictFilePath,
  DEFAULT_PROVIDER_KEYS,
  WORKER_ENV_PASSTHROUGH,
} from "../../../src/runtime/env.js";
import { makeWorkerRequest } from "../../helpers/worker-request.js";

const LEAKY_BASE: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/op",
  USER: "op",
  LANG: "en_US.UTF-8",
  TERM: "xterm-256color",
  TMPDIR: "/tmp/t",
  ANTHROPIC_API_KEY: "sk-ant-test",
  GITHUB_TOKEN: "ghp_leak",
  GH_TOKEN: "gho_leak",
  AWS_ACCESS_KEY_ID: "AKIA_LEAK",
  AWS_SECRET_ACCESS_KEY: "aws-leak",
  AWS_SESSION_TOKEN: "aws-session-leak",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  AZURE_CLIENT_SECRET: "az-leak",
  JIRA_API_TOKEN: "jira-leak",
  NPM_TOKEN: "npm-leak",
  SHELL: "/bin/zsh",
  PI_ENGINEERING_RUN_ID: "old-prefix",
  PI_SDLC_RUN_ID: "smuggled-from-parent",
};

const SCRUB_KEYS = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
  "GIT_ASKPASS",
  "GIT_SSH_COMMAND",
  "GH_CONFIG_DIR",
  "NPM_CONFIG_USERCONFIG",
];

describe("buildWorkerEnv", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pi-sdlc-env-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("never passes credentials or non-allowlisted variables through", () => {
    const env = buildWorkerEnv(LEAKY_BASE, makeWorkerRequest(), { scrub: createScrubDirs(tmp) });
    for (const key of [
      "GITHUB_TOKEN", "GH_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
      "SSH_AUTH_SOCK", "AZURE_CLIENT_SECRET", "JIRA_API_TOKEN", "NPM_TOKEN", "SHELL", "PI_ENGINEERING_RUN_ID",
    ]) {
      expect(env, key).not.toHaveProperty(key);
    }
    const allowed = new Set<string>([...WORKER_ENV_PASSTHROUGH, ...DEFAULT_PROVIDER_KEYS, ...SCRUB_KEYS]);
    for (const key of Object.keys(env)) {
      expect(allowed.has(key) || key.startsWith("PI_SDLC_"), `unexpected key ${key}`).toBe(true);
    }
  });

  it("does not pass a parent-env secret:FOO value into the worker env", () => {
    const secretValue = "super-secret-foo-value";
    const base: NodeJS.ProcessEnv = {
      ...LEAKY_BASE,
      FOO: secretValue,
      SECRET_FOO: "secret:FOO",
    };
    const env = buildWorkerEnv(base, makeWorkerRequest(), { scrub: createScrubDirs(tmp) });
    expect(env).not.toHaveProperty("FOO");
    expect(env).not.toHaveProperty("SECRET_FOO");
    expect(JSON.stringify(env)).not.toContain(secretValue);
    expect(JSON.stringify(env)).not.toContain("secret:FOO");
  });

  it("copies the passthrough basics and the allowlisted provider key", () => {
    const env = buildWorkerEnv(LEAKY_BASE, makeWorkerRequest(), { scrub: createScrubDirs(tmp) });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/op");
    expect(env.USER).toBe("op");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.TMPDIR).toBe("/tmp/t");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
  });

  it("honours a custom provider-key allowlist", () => {
    const base = { ...LEAKY_BASE, OPENAI_API_KEY: "sk-openai" };
    const env = buildWorkerEnv(base, makeWorkerRequest(), { scrub: createScrubDirs(tmp), providerKeys: ["OPENAI_API_KEY"] });
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("sets every PI_SDLC_* variable from the request, never from the parent env, with JSON root lists", () => {
    const req = makeWorkerRequest({ round: 2 });
    const env = buildWorkerEnv(LEAKY_BASE, req, { scrub: createScrubDirs(tmp) });
    expect(env.PI_SDLC_AGENT_MODE).toBe("1");
    expect(env.PI_SDLC_RUN_ID).toBe("run-test");
    expect(env.PI_SDLC_RUNS_DIR).toBe(req.runsDir);
    expect(env.PI_SDLC_STEP).toBe("implement");
    expect(env.PI_SDLC_AGENT).toBe("implementer");
    expect(env.PI_SDLC_VERDICT_FILE).toBe(join(req.runDir, "_verdicts", "implement-r2.json"));
    expect(env.PI_SDLC_WORKSPACE_DIR).toBe(req.cwd);
    expect(env.PI_SDLC_PROJECT_ROOT).toBe(req.projectRoot);
    expect(env.PI_SDLC_POLICY_FILE).toBe(req.policyFile);
    expect(env.PI_SDLC_POLICY_SHA).toBe(req.policySha);
    expect(env.PI_SDLC_EXTRA_UPSERT).toBe('["docs/**","README.md"]');
    expect(JSON.parse(env.PI_SDLC_EXTRA_UPSERT ?? "null")).toEqual(["docs/**", "README.md"]);
    expect(JSON.parse(env.PI_SDLC_DENY_UPSERT ?? "null")).toEqual(["tests/**"]);
    expect(env.PI_SDLC_NONCE).toBe("nonce-1");
    expect(env.PI_SDLC_TOOLS).toBe("read,write,edit,bash");
  });

  it("copies agent.tools into PI_SDLC_TOOLS as a lowercased comma list, honouring req.tools", () => {
    const planner = buildWorkerEnv(
      LEAKY_BASE,
      makeWorkerRequest({
        agent: { name: "planner", model: "m", promptPath: "p", tools: ["Read", "GREP", "find"], stageClass: "read-only" },
      }),
      { scrub: createScrubDirs(tmp) },
    );
    expect(planner.PI_SDLC_TOOLS).toBe("read,grep,find");
    const override = buildWorkerEnv(LEAKY_BASE, makeWorkerRequest({ tools: ["read"] }), { scrub: createScrubDirs(tmp) });
    expect(override.PI_SDLC_TOOLS).toBe("read");
  });

  it("encodes empty root lists as JSON []", () => {
    const env = buildWorkerEnv(LEAKY_BASE, makeWorkerRequest({ extraUpsert: [], denyUpsert: [] }), { scrub: createScrubDirs(tmp) });
    expect(env.PI_SDLC_EXTRA_UPSERT).toBe("[]");
    expect(env.PI_SDLC_DENY_UPSERT).toBe("[]");
  });

  it("points git, gh and npm at empty factory-owned config", async () => {
    const scrub = createScrubDirs(tmp);
    const env = buildWorkerEnv(LEAKY_BASE, makeWorkerRequest(), { scrub });
    expect(env.GIT_CONFIG_GLOBAL).toBe(scrub.gitConfigGlobal);
    expect(await readFile(scrub.gitConfigGlobal, "utf8")).toBe("");
    expect(env.GH_CONFIG_DIR).toBe(scrub.ghConfigDir);
    expect((await stat(scrub.ghConfigDir)).isDirectory()).toBe(true);
    expect(await readdir(scrub.ghConfigDir)).toEqual([]);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_ASKPASS).toBe("/usr/bin/false");
    expect(env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes -o IdentitiesOnly=yes -i /nonexistent");
    expect(env.NPM_CONFIG_USERCONFIG).toBe("/dev/null");
  });

  it("accepts extra PI_SDLC_* keys and rejects anything else", () => {
    const env = buildWorkerEnv(LEAKY_BASE, makeWorkerRequest(), {
      scrub: createScrubDirs(tmp),
      extra: {
        PI_SDLC_STUB_SCENARIO: "/tmp/scenario.json",
        PI_SDLC_STUB_LOG: "/tmp/stub.log",
        PI_SDLC_STUB_LOAD_EXTENSION: "1",
      },
    });
    expect(env.PI_SDLC_STUB_SCENARIO).toBe("/tmp/scenario.json");
    expect(env.PI_SDLC_STUB_LOG).toBe("/tmp/stub.log");
    expect(env.PI_SDLC_STUB_LOAD_EXTENSION).toBe("1");
    expect(() =>
      buildWorkerEnv(LEAKY_BASE, makeWorkerRequest(), { scrub: createScrubDirs(tmp), extra: { GITHUB_TOKEN: "x" } }),
    ).toThrow(/must start with PI_SDLC_/);
  });

  it("refuses extraEnv overrides of agent-mode, verdict, workspace, nonce, policy, and other PI_SDLC_* keys", () => {
    const locked = [
      "PI_SDLC_AGENT_MODE",
      "PI_SDLC_VERDICT_FILE",
      "PI_SDLC_WORKSPACE_DIR",
      "PI_SDLC_NONCE",
      "PI_SDLC_POLICY_SHA",
      "PI_SDLC_POLICY_FILE",
      "PI_SDLC_TOOLS",
    ];
    for (const key of locked) {
      expect(() =>
        buildWorkerEnv(LEAKY_BASE, makeWorkerRequest(), { scrub: createScrubDirs(tmp), extra: { [key]: "hijack" } }),
      ).toThrow(/cannot override a locked PI_SDLC_/);
    }
    expect(() =>
      buildWorkerEnv(LEAKY_BASE, makeWorkerRequest(), {
        scrub: createScrubDirs(tmp),
        extra: { PI_SDLC_RUN_ID: "smuggled" },
      }),
    ).toThrow(/not allowlisted/);
  });
});

describe("verdictFilePath", () => {
  it("names the verdict slot under _verdicts by stage and round", () => {
    expect(verdictFilePath("/r/run-1", "review", 3)).toBe("/r/run-1/_verdicts/review-r3.json");
  });
});
