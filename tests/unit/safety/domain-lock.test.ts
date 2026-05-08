import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkDomain, registerDomainLock } from "../../../src/safety/DomainLock.js";
import { loadTeamsConfig, parseMinimalYaml } from "../../../src/safety/teams-config.js";
import type { DomainPolicy } from "../../../src/safety/default-domains.js";

let workDir: string;

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "domain-lock-")));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("checkDomain — Write/Edit", () => {
  it("path under declared upsert root → allowed", () => {
    const srcDir = join(workDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const target = join(srcDir, "foo.ts");
    writeFileSync(target, "");
    const policy: DomainPolicy = { read: ["."], upsert: [srcDir], delete: [] };
    const r = checkDomain({
      agent: "implementer",
      operation: "Write",
      path: target,
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(true);
  });

  it("path outside upsert root → blocked with structured message including hint and allowed_paths", () => {
    const srcDir = join(workDir, "src");
    const infraDir = join(workDir, "infrastructure");
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(infraDir, { recursive: true });
    const target = join(infraDir, "main.tf");
    writeFileSync(target, "");
    const policy: DomainPolicy = { read: ["."], upsert: [srcDir], delete: [] };
    const r = checkDomain({
      agent: "implementer",
      operation: "Write",
      path: target,
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(false);
    if (r.allowed) return;
    expect(r.reason).toBe("domain-lock");
    expect(r.structured.block).toBe(true);
    expect(r.structured.agent).toBe("implementer");
    expect(r.structured.operation).toBe("Write");
    expect(r.structured.path).toBe(target);
    expect(r.structured.allowed_paths).toEqual({ upsert: [srcDir], delete: [] });
    expect(typeof r.structured.hint).toBe("string");
    expect(r.structured.hint).toMatch(/teams\.local\.yaml/);
  });

  it("symlink resolution: declared root /real/foo, target symlink → /real/foo/bar → allowed", () => {
    const realFoo = join(workDir, "real", "foo");
    mkdirSync(realFoo, { recursive: true });
    const realBar = join(realFoo, "bar");
    writeFileSync(realBar, "");
    const linkBar = join(workDir, "link-bar");
    symlinkSync(realBar, linkBar);
    const policy: DomainPolicy = { read: ["."], upsert: [realFoo], delete: [] };
    const r = checkDomain({
      agent: "implementer",
      operation: "Edit",
      path: linkBar,
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(true);
  });
});

describe("checkDomain — Bash with bash_policy", () => {
  it("script-only with matching prefix → allowed", () => {
    const policy: DomainPolicy = {
      read: ["."],
      upsert: [],
      delete: [],
      bash_policy: {
        mode: "script-only",
        runner: "uv run --script",
        allowed_scripts: ["/abs/scripts/*.py"],
      },
    };
    mkdirSync("/tmp/ds-test-scripts", { recursive: true });
    // Use real path-equality for deterministic match
    const scriptDir = join(workDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "verify.py");
    writeFileSync(scriptPath, "");
    const policy2: DomainPolicy = {
      read: ["."],
      upsert: [],
      delete: [],
      bash_policy: {
        mode: "script-only",
        runner: "uv run --script",
        allowed_scripts: [scriptDir + "/*.py"],
      },
    };
    const r = checkDomain({
      agent: "verifier",
      operation: "Bash",
      command: `uv run --script ${scriptPath}`,
      policy: policy2,
      mode: "block",
    });
    expect(r.allowed).toBe(true);
    // sanity: original policy with non-existent path also acts as expected when command does not match
    const r2 = checkDomain({
      agent: "verifier",
      operation: "Bash",
      command: "rm -rf /",
      policy,
      mode: "block",
    });
    expect(r2.allowed).toBe(false);
  });

  it("script-only with non-matching command → blocked", () => {
    const policy: DomainPolicy = {
      read: ["."],
      upsert: [],
      delete: [],
      bash_policy: {
        mode: "script-only",
        runner: "uv run --script",
        allowed_scripts: ["/allowed/x.py"],
      },
    };
    const r = checkDomain({
      agent: "verifier",
      operation: "Bash",
      command: "git status",
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(false);
    if (r.allowed) return;
    expect(r.structured.reason).toBe("domain-lock");
  });

  it("Bash without bash_policy → returns allowed:true (Layer C handles)", () => {
    const policy: DomainPolicy = { read: ["."], upsert: ["src/"], delete: [] };
    const r = checkDomain({
      agent: "implementer",
      operation: "Bash",
      command: "rm -rf /",
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(true);
  });
});

describe("checkDomain — agent without policy", () => {
  it("returns allowed:true (caller emits warn)", () => {
    const r = checkDomain({
      agent: "ghost",
      operation: "Write",
      path: "/etc/passwd",
      policy: undefined,
      mode: "block",
    });
    expect(r.allowed).toBe(true);
  });
});

describe("loadTeamsConfig — three-layer merge", () => {
  it("defaults → user → project; arrays unioned; mode resolves project > user > 'warn'", async () => {
    const userPath = join(workDir, "teams.yaml");
    const projPath = join(workDir, "teams.local.yaml");
    writeFileSync(
      userPath,
      [
        "mode: warn",
        "implementer:",
        "  read: [\".\"]",
        "  upsert:",
        "    - infrastructure/",
        "  delete: []",
      ].join("\n"),
    );
    writeFileSync(
      projPath,
      [
        "mode: block",
        "implementer:",
        "  read: [\".\"]",
        "  upsert:",
        "    - docs/",
        "  delete: []",
      ].join("\n"),
    );
    const cfg = await loadTeamsConfig({
      userPath,
      projectPath: projPath,
      runDir: "/run-dir",
      expertiseDir: "/exp-dir",
    });
    expect(cfg.mode).toBe("block");
    const impl = cfg.domains.implementer;
    expect(impl).toBeDefined();
    // Defaults provide src/, tests/, scripts/, ${RUN_DIR}/notes/. Both layers add their dirs.
    expect(impl.upsert).toEqual(expect.arrayContaining(["src/", "tests/", "scripts/", "infrastructure/", "docs/", "/run-dir/notes/"]));
  });

  it("missing user/project files → returns defaults silently", async () => {
    const cfg = await loadTeamsConfig({
      userPath: join(workDir, "missing-user.yaml"),
      projectPath: join(workDir, "missing-proj.yaml"),
      runDir: "/r",
      expertiseDir: "/e",
    });
    expect(cfg.mode).toBe("warn");
    expect(cfg.domains.implementer.upsert).toEqual(expect.arrayContaining(["src/", "tests/", "scripts/", "/r/notes/"]));
  });

  it("user yaml mode 'warn' inherits when project missing", async () => {
    const userPath = join(workDir, "teams.yaml");
    writeFileSync(userPath, "mode: warn\n");
    const cfg = await loadTeamsConfig({
      userPath,
      projectPath: join(workDir, "absent.yaml"),
      runDir: "/r",
      expertiseDir: "/e",
    });
    expect(cfg.mode).toBe("warn");
  });
});

describe("parseMinimalYaml", () => {
  it("parses inline arrays, block lists, and nested mappings", () => {
    const txt = [
      "mode: block",
      "implementer:",
      "  read: [\".\", \"src/\"]",
      "  upsert:",
      "    - src/",
      "    - tests/",
      "  delete: []",
      "verifier:",
      "  bash_policy:",
      "    mode: script-only",
      "    runner: uv run --script",
      "    allowed_scripts:",
      "      - ~/.pi/scripts/x.py",
    ].join("\n");
    const r = parseMinimalYaml(txt) as any;
    expect(r.mode).toBe("block");
    expect(r.implementer.read).toEqual([".", "src/"]);
    expect(r.implementer.upsert).toEqual(["src/", "tests/"]);
    expect(r.implementer.delete).toEqual([]);
    expect(r.verifier.bash_policy.mode).toBe("script-only");
    expect(r.verifier.bash_policy.runner).toBe("uv run --script");
    expect(r.verifier.bash_policy.allowed_scripts).toEqual(["~/.pi/scripts/x.py"]);
  });
});

describe("registerDomainLock — wrapper behavior", () => {
  type Handler = (event: any, ctx: any) => Promise<any>;
  const makePi = () => {
    const handlers: Handler[] = [];
    const pi: any = {
      on: (_evt: string, h: Handler) => handlers.push(h),
    };
    return { pi, handlers };
  };

  it("mode 'warn': blocked operation produces allowed:false but wrapper emits domain_warn and lets execution proceed", async () => {
    const { pi, handlers } = makePi();
    const events: any[] = [];
    const policy: DomainPolicy = { read: ["."], upsert: [join(workDir, "src")], delete: [] };
    registerDomainLock(pi, {
      getPolicyForAgent: () => policy,
      mode: "warn",
      emitEvent: (e) => events.push(e),
    });
    const result = await handlers[0](
      {
        tool: { name: "Write" },
        toolInput: { file_path: join(workDir, "infra", "main.tf") },
      },
      {},
    );
    expect(result).toBeUndefined();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("domain_warn");
  });

  it("mode 'block': blocked operation produces wrapper return {block:true} and emits domain_block", async () => {
    const { pi, handlers } = makePi();
    const events: any[] = [];
    const policy: DomainPolicy = { read: ["."], upsert: [join(workDir, "src")], delete: [] };
    registerDomainLock(pi, {
      getPolicyForAgent: () => policy,
      mode: "block",
      emitEvent: (e) => events.push(e),
    });
    const result = await handlers[0](
      {
        tool: { name: "Write" },
        toolInput: { file_path: join(workDir, "infra", "main.tf") },
      },
      {},
    );
    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    expect(result.layer).toBe("D");
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("domain_block");
  });

  it("agent with no policy → emits domain_warn and allows", async () => {
    const { pi, handlers } = makePi();
    const events: any[] = [];
    registerDomainLock(pi, {
      getPolicyForAgent: () => undefined,
      mode: "block",
      emitEvent: (e) => events.push(e),
    });
    const result = await handlers[0](
      {
        tool: { name: "Write" },
        toolInput: { file_path: "/tmp/foo" },
      },
      {},
    );
    expect(result).toBeUndefined();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("domain_warn");
    expect(events[0].payload.reason).toBe("no-policy");
  });
});
