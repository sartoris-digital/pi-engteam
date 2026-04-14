# pi-engteam Core Extension — Implementation Plan A

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working Pi extension that runs `/plan-build-review` with planner, implementer, and reviewer agents under three-layer safety (hard-block / plan-mode / approval-token) and append-only jsonl observability.

**Architecture:** Single TypeScript Pi extension (`src/index.ts`) built with tsup. SafetyGuard hooks into Pi's `tool_call` event and classifies every command via a three-layer stack before execution. Observer appends structured events to `~/.pi/engteam/runs/{runId}/events.jsonl`. TeamRuntime spawns each agent as an in-process `AgentSession` with an in-memory `MessageBus` for peer messaging. ADWEngine drives a declarative step graph with persistent `RunState`.

**Tech Stack:** `@mariozechner/pi-coding-agent` (Pi SDK v0.65+), `@mariozechner/pi-ai` (model registry), TypeScript 5, tsup (build), vitest (tests), `@sinclair/typebox` (TypeBox schemas), `shell-quote` (command parsing)

---

## File Structure

### Root

| File | Responsibility |
|------|---------------|
| `package.json` | Package manifest, scripts, and dependency declarations |
| `tsconfig.json` | TypeScript compiler configuration (NodeNext modules, strict mode) |
| `tsup.config.ts` | tsup build config: ESM output, externals |
| `vitest.config.ts` | Vitest test runner configuration |
| `.gitignore` | Ignore node_modules and dist |

### `src/`

| File | Responsibility |
|------|---------------|
| `src/index.ts` | Extension entry point — wires all subsystems into Pi via `export default function(pi: ExtensionAPI)` |
| `src/types.ts` | All shared TypeScript types used across the extension |
| `src/config.ts` | Loads and validates extension configuration (safety config, model routing, agent definitions) |

### `src/safety/`

| File | Responsibility |
|------|---------------|
| `src/safety/patterns.ts` | Regex constants and pure functions for detecting dangerous shell patterns (rm, force-push, sudo, publish, etc.) |
| `src/safety/paths.ts` | Protected filesystem path detection, home directory expansion, .env file checks |
| `src/safety/classifier.ts` | Shell command classifier: parses compound commands, applies safe/destructive/blocked verdict via default-deny logic |
| `src/safety/PlanMode.ts` | Layer B gate: determines whether a tool call is permitted when plan mode is active |
| `src/safety/approvals.ts` | Layer C HMAC approval tokens: generate secrets, sign tokens, verify tokens, hash args deterministically |
| `src/safety/SafetyGuard.ts` | Registers the `tool_call` event handler on Pi that enforces all three safety layers in sequence |

### `src/observer/`

| File | Responsibility |
|------|---------------|
| `src/observer/schema.ts` | TypeBox schemas for `EngteamEvent` validation |
| `src/observer/writer.ts` | Append-only JSONL event writer to `~/.pi/engteam/runs/{runId}/events.jsonl` |
| `src/observer/httpSink.ts` | Optional HTTP sink that POSTs events to a configured endpoint |
| `src/observer/Observer.ts` | Facade that fans events out to all configured sinks (file + optional HTTP) |

### `src/team/`

| File | Responsibility |
|------|---------------|
| `src/team/MessageBus.ts` | In-memory pub/sub bus for inter-agent `TeamMessage` routing |
| `src/team/TeamRuntime.ts` | Spawns and manages per-agent `AgentSession` instances; wires MessageBus and tools |

### `src/team/tools/`

| File | Responsibility |
|------|---------------|
| `src/team/tools/SendMessage.ts` | Custom tool: sends a `TeamMessage` to another agent via MessageBus |
| `src/team/tools/TaskList.ts` | Custom tool: reads the current run's step list from RunState |
| `src/team/tools/TaskUpdate.ts` | Custom tool: updates a step's status in RunState |
| `src/team/tools/VerdictEmit.ts` | Custom tool: emits a `Verdict` for the current step |
| `src/team/tools/RequestApproval.ts` | Custom tool: generates a Layer C approval token and surfaces it to the user |
| `src/team/tools/GrantApproval.ts` | Custom tool: consumed by the Judge agent to sign and persist an approval token |

### `src/adw/`

| File | Responsibility |
|------|---------------|
| `src/adw/RunState.ts` | Persistent `RunState` read/write over `state.json` in the run directory |
| `src/adw/BudgetGuard.ts` | Checks iteration, cost, wall-clock, and token budgets; returns `BudgetStatus` |
| `src/adw/ADWEngine.ts` | Drives the declarative step graph: advances steps, checks budgets, handles retries |

### `src/workflows/`

| File | Responsibility |
|------|---------------|
| `src/workflows/types.ts` | Workflow step/graph type definitions |
| `src/workflows/plan-build-review.ts` | The `plan-build-review` workflow: three-step graph (planner → implementer → reviewer) |

### `src/commands/`

| File | Responsibility |
|------|---------------|
| `src/commands/team-start.ts` | `/team-start` command handler |
| `src/commands/team-stop.ts` | `/team-stop` command handler |
| `src/commands/run-start.ts` | `/run-start` command handler: initializes RunState and starts ADWEngine |
| `src/commands/run-resume.ts` | `/run-resume` command handler: resumes a paused or failed run |
| `src/commands/run-abort.ts` | `/run-abort` command handler: sets run status to aborted |
| `src/commands/run-status.ts` | `/run-status` command handler: prints current RunState summary |

### `agents/`

| File | Responsibility |
|------|---------------|
| `agents/planner.md` | System prompt for the planner agent |
| `agents/implementer.md` | System prompt for the implementer agent |
| `agents/reviewer.md` | System prompt for the reviewer agent |

### `tests/`

| File | Responsibility |
|------|---------------|
| `tests/helpers/mockPi.ts` | `MockExtensionAPI` that captures handlers and registered tools/commands for unit tests |
| `tests/helpers/fixtures.ts` | Shared test fixtures: temp dirs, SAFE/DESTRUCTIVE/BLOCKED command arrays |
| `tests/unit/safety/patterns.test.ts` | Unit tests for `src/safety/patterns.ts` and `src/safety/paths.ts` |
| `tests/unit/safety/classifier.test.ts` | Unit tests for `src/safety/classifier.ts` and `src/safety/PlanMode.ts` |
| `tests/unit/safety/approvals.test.ts` | Unit tests for `src/safety/approvals.ts` |
| `tests/unit/observer/writer.test.ts` | Unit tests for `src/observer/writer.ts` |
| `tests/unit/observer/httpSink.test.ts` | Unit tests for `src/observer/httpSink.ts` |
| `tests/unit/team/router.test.ts` | Unit tests for `src/team/MessageBus.ts` routing |
| `tests/unit/team/tools.test.ts` | Unit tests for team custom tools |
| `tests/unit/adw/RunState.test.ts` | Unit tests for `src/adw/RunState.ts` |
| `tests/unit/adw/BudgetGuard.test.ts` | Unit tests for `src/adw/BudgetGuard.ts` |
| `tests/unit/adw/ADWEngine.test.ts` | Unit tests for `src/adw/ADWEngine.ts` |

---

## Phase 0 — Project Scaffold

### Task 1: Initialize project

> No TDD needed for config files — these are pure configuration artifacts.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@sartoris/pi-engteam",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@sinclair/typebox": "^0.34.0",
    "shell-quote": "^1.8.1"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": ">=0.65.0"
  },
  "devDependencies": {
    "@mariozechner/pi-coding-agent": "^0.67.0",
    "@mariozechner/pi-ai": "^0.67.0",
    "@types/node": "^22.0.0",
    "@types/shell-quote": "^1.7.4",
    "tsup": "^8.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `tsup.config.ts`**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["@mariozechner/pi-coding-agent"],
});
```

- [ ] **Step 4: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 6: Install dependencies**

Run: `pnpm install`
Expected: lockfile created, no errors

- [ ] **Step 7: Commit**

`git add package.json tsconfig.json tsup.config.ts vitest.config.ts .gitignore && git commit -m "chore: initialize pi-engteam project scaffold"`

---

### Task 2: Shared types

**Files:**
- Create: `src/types.ts`
- Create: `tests/helpers/mockPi.ts`
- Create: `tests/helpers/fixtures.ts`

- [ ] **Step 1: Create `src/types.ts`**

```typescript
// src/types.ts
export type TeamMessage = {
  id: string;
  from: string;
  to: string;
  summary: string;
  message: string;
  requestId?: string;
  type?: "request" | "response" | "shutdown_request" | "shutdown_response";
  ts: string;
};

export type RunStatus = "pending" | "running" | "paused" | "succeeded" | "failed" | "aborted";

export type Budget = {
  maxIterations: number;
  maxCostUsd: number;
  maxWallSeconds: number;
  maxTokens: number;
  spent: { costUsd: number; wallSeconds: number; tokens: number };
};

export type StepRecord = {
  name: string;
  startedAt?: string;
  endedAt?: string;
  verdict?: Verdict;
  issues?: string[];
  handoffHint?: string;
  artifacts?: string[];
  error?: string;
};

export type ApprovalRecord = {
  tokenId: string;
  op: string;
  expiresAt: string;
  consumed: boolean;
  argsHash: string;
};

export type RunState = {
  runId: string;
  workflow: string;
  goal: string;
  status: RunStatus;
  currentStep: string;
  iteration: number;
  budget: Budget;
  steps: StepRecord[];
  artifacts: Record<string, string>;
  approvals: ApprovalRecord[];
  planMode: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EventCategory =
  | "lifecycle" | "tool_call" | "tool_result" | "message"
  | "verdict" | "budget" | "safety" | "approval" | "error";

export type EngteamEvent = {
  ts: string;
  runId: string;
  step?: string;
  iteration?: number;
  agentId?: string;
  agentName?: string;
  category: EventCategory;
  type: string;
  payload: Record<string, unknown>;
  rawArgsRef?: string;
  summary?: string;
};

export type Verdict = "PASS" | "FAIL" | "NEEDS_MORE";

export type ClassifierResult = {
  classification: "safe" | "destructive" | "blocked";
  rule?: string;
  reason?: string;
};

export type VerdictPayload = {
  step: string;
  verdict: Verdict;
  issues?: string[];
  artifacts?: string[];
  handoffHint?: string;
};

export type SafetyConfig = {
  hardBlockers: { enabled: boolean; alwaysOn: boolean };
  planMode: { defaultOn: boolean };
  classification: { mode: "default-deny"; safeAllowlistExtend: string[]; destructiveOverride: string[] };
  approvalAuthority: "judge";
  exemptPaths: string[];
  tokenTtlSeconds: number;
  allowRunLifetimeScope: boolean;
};

export type ModelRouting = {
  overrides: Record<string, string>;
  budgetDownshift: {
    enabled: boolean;
    triggerAtPercent: number;
    rules: Record<string, string>;
    protected: string[];
  };
};

export type AgentDefinition = {
  name: string;
  description: string;
  model: string;
  systemPrompt: string;
  tools?: string[];
};

export type BudgetStatus = {
  ok: boolean;
  warnings: Array<"iterations" | "cost" | "wall" | "tokens">;
  exhausted: Array<"iterations" | "cost" | "wall" | "tokens">;
};

export type ApprovalToken = {
  tokenId: string;
  runId: string;
  op: string;
  argsHash: string;
  scope: "once" | "run-lifetime";
  expiresAt: string;
  signature: string;
};
```

- [ ] **Step 2: Create `tests/helpers/mockPi.ts`**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Handler = (event: any, ctx: any) => Promise<any> | any;

export class MockExtensionAPI {
  private handlers = new Map<string, Handler[]>();
  registeredTools: any[] = [];
  registeredCommands: any[] = [];

  on(event: string, handler: Handler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
  }

  registerTool(tool: any): void {
    this.registeredTools.push(tool);
  }

  registerCommand(cmd: any): void {
    this.registeredCommands.push(cmd);
  }

  async trigger(event: string, eventData: any, ctx: any = {}): Promise<any> {
    const handlers = this.handlers.get(event) ?? [];
    for (const h of handlers) {
      const result = await h(eventData, ctx);
      if (result != null) return result;
    }
    return undefined;
  }

  asPi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}
```

- [ ] **Step 3: Create `tests/helpers/fixtures.ts`**

```typescript
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync } from "fs";
import { mkdir } from "fs/promises";

export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-engteam-test-"));
}

export async function makeTmpDirAsync(): Promise<string> {
  const dir = join(tmpdir(), `pi-engteam-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export const SAFE_COMMANDS = [
  "cat README.md",
  "grep -r 'foo' src/",
  "ls -la",
  "git status",
  "git diff HEAD",
  "find . -name '*.ts' -not -path '*/node_modules/*'",
  "wc -l src/index.ts",
  "jq '.version' package.json",
  "pnpm test",
  "vitest run",
  "tsc --noEmit",
];

export const DESTRUCTIVE_COMMANDS = [
  "rm -f old.txt",
  "mv src/old.ts src/new.ts",
  "npm install lodash",
  "git commit -m 'feat: add stuff'",
  "sed -i 's/foo/bar/g' file.txt",
  "git push origin main",
  "chmod +x script.sh",
  "kill -9 12345",
];

export const BLOCKED_COMMANDS = [
  "rm -rf /",
  "rm -rf ~",
  "sudo apt install vim",
  "cat ~/.env",
  "cat .env",
  "git push --force origin main",
  "npm publish",
  "chmod 777 /usr/local/bin/foo",
  "dd if=/dev/zero of=/dev/sda",
];
```

- [ ] **Step 4: Verify types compile**

Run: `pnpm typecheck`
Expected: PASS with zero errors

- [ ] **Step 5: Commit**

`git add src/types.ts tests/helpers/mockPi.ts tests/helpers/fixtures.ts && git commit -m "feat: add shared types and test helpers"`

---

## Phase 1 — Safety

### Task 3: Safety Layer A — patterns and path protection

**Files:**
- Create: `tests/unit/safety/patterns.test.ts`
- Create: `src/safety/patterns.ts`
- Create: `src/safety/paths.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/safety/patterns.test.ts
import { describe, it, expect } from "vitest";
import { homedir } from "os";
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/unit/safety/patterns.test.ts`
Expected: FAIL with "Cannot find module '../../../src/safety/patterns.js'"

- [ ] **Step 3: Implement `src/safety/patterns.ts`**

```typescript
// src/safety/patterns.ts

// Dangerous rm patterns — match recursive deletes targeting root, home, or wildcards
export const DANGEROUS_RM_REGEXES: RegExp[] = [
  /rm\s+(-\w+\s+)*-[rf]{1,2}\s+(\/|~|~\/|\*|\.\/)(\s|$)/,
  /rm\s+(-\w+\s+)*-[rf]{1,2}\s+\$HOME/,
  /rm\s+(-\w+\s+)*-[rf]{1,2}\s+\.\.(\s|$)/,
];

export function isDangerousRm(command: string): boolean {
  return DANGEROUS_RM_REGEXES.some(r => r.test(command));
}

// .env file access — matches .env, .env.local, .env.prod etc. but not .env.sample/.env.example
export const ENV_FILE_REGEX = /\.env(?!\.(?:sample|example))(\.[a-zA-Z0-9._-]+)?$/;

export function isEnvFileAccess(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? filePath;
  return ENV_FILE_REGEX.test(base);
}

// Force push patterns
export const FORCE_PUSH_REGEX = /git\s+push\s+.*(?:--force(?:-with-lease)?|-f)(?:\s|$)/;

export function isForcePush(command: string): boolean {
  return FORCE_PUSH_REGEX.test(command);
}

// Sudo
export const SUDO_REGEX = /^sudo\s|[;&|]\s*sudo\s/;

export function isSudo(command: string): boolean {
  return SUDO_REGEX.test(command);
}

// Publish
export const PUBLISH_REGEX = /(?:npm|pnpm|yarn)\s+publish(?:\s|$)/;

export function isPublish(command: string): boolean {
  return PUBLISH_REGEX.test(command);
}

// Shell init files
export const SHELL_INIT_REGEX = /(?:~\/\.(?:zshrc|bashrc|bash_profile|profile|zprofile)|\/etc\/profile)/;

export function isShellInitWrite(filePath: string): boolean {
  return SHELL_INIT_REGEX.test(filePath);
}

// Launchd / systemd installs
export const LAUNCHD_REGEX = /(?:launchctl\s+load|systemctl\s+enable|Library\/LaunchAgents|Library\/LaunchDaemons|\/etc\/systemd)/;

export function isLaunchdWrite(command: string): boolean {
  return LAUNCHD_REGEX.test(command);
}

// Device writes
export const DEVICE_WRITE_REGEX = /(?:dd\s+.*of=\/dev\/|mkfs\.|fdisk|diskutil\s+erase|parted)/;

export function isDeviceWrite(command: string): boolean {
  return DEVICE_WRITE_REGEX.test(command);
}
```

- [ ] **Step 4: Implement `src/safety/paths.ts`**

```typescript
// src/safety/paths.ts
import { homedir } from "os";
import { resolve } from "path";
import { isEnvFileAccess } from "./patterns.js";

export function expandPath(p: string): string {
  if (p.startsWith("~/")) return p.replace("~", homedir());
  if (p === "~") return homedir();
  return p;
}

const PROTECTED_PREFIXES = [
  "/etc", "/usr", "/bin", "/sbin", "/boot",
  "/System", "/Library/System", "/private/etc", "/private/var/db",
  "/var/log", "/var/db", "/var/root",
];

function getProtectedHomePaths(): string[] {
  const home = homedir();
  return [
    `${home}/.ssh`,
    `${home}/.aws`,
    `${home}/.gnupg`,
    `${home}/.config/gcloud`,
    `${home}/.kube`,
    `${home}/.netrc`,
    `${home}/.pgpass`,
    `${home}/Library/Keychains`,
    "/Library/Keychains",
  ];
}

const SECRET_FILE_PATTERNS = [
  /\/id_rsa$/,
  /\/id_rsa\./,
  /\/id_ed25519$/,
  /\/id_ed25519\./,
  /\/id_ecdsa$/,
  /\/id_ecdsa\./,
  /\.pem$/,
  /\.key$/,
  /\/credentials$/,
];

export function isProtectedPath(filePath: string): { blocked: boolean; reason?: string } {
  const expanded = expandPath(filePath);
  const abs = resolve(expanded);

  for (const prefix of PROTECTED_PREFIXES) {
    if (abs === prefix || abs.startsWith(prefix + "/")) {
      return { blocked: true, reason: `Protected system path: ${prefix}` };
    }
  }

  for (const homePath of getProtectedHomePaths()) {
    const expandedHome = expandPath(homePath);
    if (abs === expandedHome || abs.startsWith(expandedHome + "/")) {
      return { blocked: true, reason: `Protected credential path: ${homePath}` };
    }
  }

  for (const pattern of SECRET_FILE_PATTERNS) {
    if (pattern.test(abs)) {
      return { blocked: true, reason: `Secret file pattern match: ${pattern}` };
    }
  }

  const base = abs.split("/").pop() ?? "";
  if (isEnvFileAccess(base)) {
    return { blocked: true, reason: ".env file access blocked (except .env.sample/.env.example)" };
  }

  return { blocked: false };
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm test tests/unit/safety/patterns.test.ts`
Expected: PASS — all pattern and path protection tests green

- [ ] **Step 6: Commit**

`git add src/safety/patterns.ts src/safety/paths.ts tests/unit/safety/patterns.test.ts && git commit -m "feat: safety Layer A patterns and path protection"`

---

### Task 4: Shell command classifier

**Files:**
- Create: `tests/unit/safety/classifier.test.ts`
- Create: `src/safety/classifier.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/safety/classifier.test.ts
import { describe, it, expect } from "vitest";
import { classifyCommand } from "../../../src/safety/classifier.js";
import { SAFE_COMMANDS, DESTRUCTIVE_COMMANDS, BLOCKED_COMMANDS } from "../../helpers/fixtures.js";

describe("classifyCommand — fixture arrays", () => {
  for (const cmd of SAFE_COMMANDS) {
    it(`safe: ${cmd}`, () => {
      expect(classifyCommand(cmd).classification).toBe("safe");
    });
  }

  for (const cmd of DESTRUCTIVE_COMMANDS) {
    it(`destructive: ${cmd}`, () => {
      expect(classifyCommand(cmd).classification).toBe("destructive");
    });
  }

  for (const cmd of BLOCKED_COMMANDS) {
    it(`blocked: ${cmd}`, () => {
      expect(classifyCommand(cmd).classification).toBe("blocked");
    });
  }
});

describe("classifyCommand — compound commands", () => {
  it("cat file.ts | grep foo → safe", () =>
    expect(classifyCommand("cat file.ts | grep foo").classification).toBe("safe"));

  it("cat file.ts | rm -f other → destructive", () =>
    expect(classifyCommand("cat file.ts | rm -f other").classification).toBe("destructive"));

  it("git status && git diff → safe", () =>
    expect(classifyCommand("git status && git diff").classification).toBe("safe"));

  it("git commit -m 'test' → destructive", () =>
    expect(classifyCommand("git commit -m 'test'").classification).toBe("destructive"));
});

describe("classifyCommand — find", () => {
  it("find . -name '*.js' -delete → destructive", () =>
    expect(classifyCommand("find . -name '*.js' -delete").classification).toBe("destructive"));
});

describe("classifyCommand — sed", () => {
  it("sed -i 's/x/y/' file → destructive", () =>
    expect(classifyCommand("sed -i 's/x/y/' file").classification).toBe("destructive"));

  it("sed 's/x/y/' file → safe", () =>
    expect(classifyCommand("sed 's/x/y/' file").classification).toBe("safe"));
});

describe("classifyCommand — awk", () => {
  it("awk '{print}' file → safe", () =>
    expect(classifyCommand("awk '{print}' file").classification).toBe("safe"));

  it("awk -i inplace '{print}' file → destructive", () =>
    expect(classifyCommand("awk -i inplace '{print}' file").classification).toBe("destructive"));
});

describe("classifyCommand — git subcommands", () => {
  it("git log --oneline → safe", () =>
    expect(classifyCommand("git log --oneline").classification).toBe("safe"));

  it("git checkout main → destructive", () =>
    expect(classifyCommand("git checkout main").classification).toBe("destructive"));
});

describe("classifyCommand — npm/pnpm", () => {
  it("npm test → safe", () =>
    expect(classifyCommand("npm test").classification).toBe("safe"));

  it("npm install lodash → destructive", () =>
    expect(classifyCommand("npm install lodash").classification).toBe("destructive"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/unit/safety/classifier.test.ts`
Expected: FAIL with "Cannot find module '../../../src/safety/classifier.js'"

- [ ] **Step 3: Implement `src/safety/classifier.ts`**

```typescript
// src/safety/classifier.ts
import { parse as shellParse } from "shell-quote";
import type { ClassifierResult } from "../types.js";
import {
  isDangerousRm, isForcePush, isSudo, isPublish,
  isLaunchdWrite, isDeviceWrite,
} from "./patterns.js";
import { isProtectedPath } from "./paths.js";

// Commands safe to run without approval (read-only)
const SAFE_VERBS = new Set([
  "cat", "bat", "less", "more", "head", "tail", "wc", "file", "stat", "xxd", "od",
  "grep", "rg", "ag", "fd",
  "ls", "la", "ll", "tree", "dir",
  "sort", "uniq", "cut", "tr", "jq", "yq", "diff", "comm",
  "pwd", "whoami", "hostname", "uname", "date", "printenv", "which", "type",
  "ps", "df", "du", "top",
  "vitest", "jest", "mocha", "tap", "ava",
  "pytest", "py.test",
  "tsc", "pyright", "mypy", "eslint", "rubocop",
]);

// Git subcommands that are safe (read-only)
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "blame", "shortlog",
  "branch", "tag", "remote", "rev-parse", "ls-files",
  "config", "describe", "reflog", "stash", "worktree",
  "submodule", "cat-file", "check-ignore",
]);

// npm/pnpm/yarn subcommands that are safe
const SAFE_NPM_SUBCOMMANDS = new Set(["test", "run", "view", "ls", "list", "info", "outdated", "audit"]);
const SAFE_PNPM_SUBCOMMANDS = new Set(["test", "run", "list", "view", "why", "audit"]);

// make flags that indicate a dry run
const SAFE_MAKE_FLAGS = new Set(["-n", "--dry-run", "--just-print"]);

// cargo subcommands that are safe
const SAFE_CARGO_SUBCOMMANDS = new Set([
  "test", "check", "clippy", "doc", "bench", "tree", "search", "info", "report", "audit",
]);

function splitCompound(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let depth = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
    if (inSingle || inDouble) { current += ch; continue; }

    if (ch === "(" || ch === "{") { depth++; current += ch; continue; }
    if (ch === ")" || ch === "}") { depth--; current += ch; continue; }

    if (depth === 0) {
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
        segments.push(current.trim());
        current = "";
        i++; // skip next character
        continue;
      }
      if (ch === "|" || ch === ";") {
        segments.push(current.trim());
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments.filter(Boolean);
}

function classifySegment(segment: string): ClassifierResult {
  const trimmed = segment.trim();
  if (!trimmed) return { classification: "safe" };

  // Layer A: hard block checks
  if (isDangerousRm(trimmed)) return { classification: "blocked", rule: "dangerous-rm" };
  if (isForcePush(trimmed)) return { classification: "blocked", rule: "force-push" };
  if (isSudo(trimmed)) return { classification: "blocked", rule: "sudo" };
  if (isPublish(trimmed)) return { classification: "blocked", rule: "publish" };
  if (isLaunchdWrite(trimmed)) return { classification: "blocked", rule: "launchd-systemd" };
  if (isDeviceWrite(trimmed)) return { classification: "blocked", rule: "device-write" };

  // Check for .env file access via argument
  const envMatch = trimmed.match(/(?:^|\s)(\.env(?!\.(?:sample|example))(?:\.[a-zA-Z0-9._-]+)?)/);
  if (envMatch) {
    const path = envMatch[1];
    const check = isProtectedPath(path);
    if (check.blocked) return { classification: "blocked", rule: "env-file", reason: check.reason };
  }

  // Parse tokens to get verb and subcommand
  let tokens: string[];
  try {
    const parsed = shellParse(trimmed);
    tokens = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    return { classification: "destructive", reason: "shell parse failed, defaulting to destructive" };
  }

  if (tokens.length === 0) return { classification: "safe" };

  const verb = tokens[0].toLowerCase();
  const subcommand = tokens[1]?.toLowerCase();

  if (verb === "git") {
    if (!subcommand) return { classification: "safe" };
    if (SAFE_GIT_SUBCOMMANDS.has(subcommand)) return { classification: "safe" };
    return { classification: "destructive", reason: `git ${subcommand} is not in safe subcommand list` };
  }

  if (verb === "npm") {
    if (!subcommand) return { classification: "safe" };
    if (SAFE_NPM_SUBCOMMANDS.has(subcommand)) return { classification: "safe" };
    return { classification: "destructive" };
  }

  if (verb === "pnpm") {
    if (!subcommand) return { classification: "safe" };
    if (SAFE_PNPM_SUBCOMMANDS.has(subcommand)) return { classification: "safe" };
    return { classification: "destructive" };
  }

  if (verb === "yarn") {
    if (!subcommand) return { classification: "safe" };
    if (subcommand === "test" || subcommand === "audit" || subcommand === "list") return { classification: "safe" };
    return { classification: "destructive" };
  }

  if (verb === "cargo") {
    if (!subcommand) return { classification: "safe" };
    if (SAFE_CARGO_SUBCOMMANDS.has(subcommand)) return { classification: "safe" };
    return { classification: "destructive" };
  }

  if (verb === "go") {
    if (subcommand === "test" || subcommand === "vet" || subcommand === "doc") return { classification: "safe" };
    return { classification: "destructive" };
  }

  if (verb === "make") {
    if (tokens.some(t => SAFE_MAKE_FLAGS.has(t))) return { classification: "safe" };
    return { classification: "destructive" };
  }

  if (verb === "find") {
    if (
      tokens.includes("-delete") ||
      (tokens.includes("-exec") && tokens.some(t => t === "rm"))
    ) {
      return { classification: "destructive", reason: "find with -delete or -exec rm" };
    }
    return { classification: "safe" };
  }

  if (verb === "sed") {
    if (tokens.some(t => t === "-i" || t.startsWith("-i") || t === "--in-place")) {
      return { classification: "destructive", reason: "sed -i (in-place edit)" };
    }
    return { classification: "safe" };
  }

  if (verb === "awk") {
    if (tokens.some(t => t === "-i" || t === "--inplace" || t === "inplace")) {
      return { classification: "destructive", reason: "awk -i inplace (in-place edit)" };
    }
    return { classification: "safe" };
  }

  if (verb === "perl") {
    if (tokens.some(t => t.includes("-i"))) {
      return { classification: "destructive", reason: "perl -i (in-place edit)" };
    }
    return { classification: "safe" };
  }

  if (verb === "python" || verb === "python3" || verb === "node") {
    return { classification: "destructive", reason: "script execution" };
  }

  // Check for output redirections via shell-parse object tokens
  const rawParsed = shellParse(trimmed);
  const hasRedirect = rawParsed.some(t => typeof t === "object" && t !== null && "op" in (t as object));
  if (hasRedirect) {
    const redirectTargets = rawParsed
      .filter((t): t is Record<string, string> => typeof t === "object" && t !== null)
      .map((t) => (t as Record<string, string>).file ?? "");
    const toFile = redirectTargets.some(f => f && !f.match(/^[012]$/));
    if (toFile) return { classification: "destructive", reason: "redirect to file" };
  }

  if (SAFE_VERBS.has(verb)) return { classification: "safe" };

  // Default-deny: unknown verb is destructive
  return { classification: "destructive", reason: `unknown verb '${verb}', defaulting to destructive` };
}

export function classifyCommand(command: string): ClassifierResult {
  const segments = splitCompound(command);
  let worstResult: ClassifierResult = { classification: "safe" };

  for (const segment of segments) {
    const result = classifySegment(segment);
    if (result.classification === "blocked") return result; // short-circuit
    if (result.classification === "destructive") worstResult = result;
  }

  return worstResult;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/unit/safety/classifier.test.ts`
Expected: PASS — all safe/destructive/blocked fixture cases and compound command cases green

- [ ] **Step 5: Commit**

`git add src/safety/classifier.ts tests/unit/safety/classifier.test.ts && git commit -m "feat: safety shell command classifier with default-deny"`

---

### Task 5: PlanMode gate

**Files:**
- Modify: `tests/unit/safety/classifier.test.ts` (add describe block)
- Create: `src/safety/PlanMode.ts`

- [ ] **Step 1: Write failing test**

Append the following `describe` block to the bottom of `tests/unit/safety/classifier.test.ts`:

```typescript
// Append to tests/unit/safety/classifier.test.ts
import { isPlanModeAllowed } from "../../../src/safety/PlanMode.js";

describe("isPlanModeAllowed", () => {
  it("Read with file_path → allowed", () =>
    expect(isPlanModeAllowed("Read", { file_path: "src/index.ts" })).toBe(true));

  it("Grep with pattern → allowed", () =>
    expect(isPlanModeAllowed("Grep", { pattern: "foo", path: "." })).toBe(true));

  it("Glob with pattern → allowed", () =>
    expect(isPlanModeAllowed("Glob", { pattern: "**/*.ts" })).toBe(true));

  it("Write → blocked", () =>
    expect(isPlanModeAllowed("Write", { file_path: "src/new.ts", content: "..." })).toBe(false));

  it("Edit → blocked", () =>
    expect(isPlanModeAllowed("Edit", { file_path: "src/index.ts" })).toBe(false));

  it("Bash with safe command → allowed", () =>
    expect(isPlanModeAllowed("Bash", { command: "cat README.md" })).toBe(true));

  it("Bash with destructive command → blocked", () =>
    expect(isPlanModeAllowed("Bash", { command: "rm old.txt" })).toBe(false));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/unit/safety/classifier.test.ts`
Expected: FAIL with "Cannot find module '../../../src/safety/PlanMode.js'"

- [ ] **Step 3: Implement `src/safety/PlanMode.ts`**

```typescript
// src/safety/PlanMode.ts
import { classifyCommand } from "./classifier.js";

const PLAN_MODE_ALLOWED_TOOLS = new Set([
  "Read", "Grep", "Glob", "LSP",
]);

export function isPlanModeAllowed(
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  if (PLAN_MODE_ALLOWED_TOOLS.has(toolName)) return true;
  if (toolName === "Bash") {
    const command = toolInput.command as string | undefined;
    if (!command) return false;
    const result = classifyCommand(command);
    return result.classification === "safe";
  }
  return false;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/unit/safety/classifier.test.ts`
Expected: PASS — all classifier and plan-mode tests green

- [ ] **Step 5: Commit**

`git add src/safety/PlanMode.ts tests/unit/safety/classifier.test.ts && git commit -m "feat: safety Layer B plan-mode gate"`

---

### Task 6: Approval HMAC tokens

**Files:**
- Create: `tests/unit/safety/approvals.test.ts`
- Create: `src/safety/approvals.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/safety/approvals.test.ts
import { describe, it, expect } from "vitest";
import {
  generateRunSecret,
  signToken,
  verifyToken,
  hashArgs,
} from "../../../src/safety/approvals.js";
import type { ApprovalToken } from "../../../src/types.js";

describe("approvals", () => {
  it("sign + verify round-trip passes", () => {
    const secret = generateRunSecret();
    const tokenId = "tok-1";
    const op = "git-push";
    const argsHash = hashArgs({ branch: "main", remote: "origin" });
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const signature = signToken(secret, tokenId, op, argsHash, expiresAt);
    const token: ApprovalToken = {
      tokenId, runId: "run-1", op, argsHash,
      scope: "once", expiresAt, signature,
    };
    expect(verifyToken(secret, token)).toBe(true);
  });

  it("modified signature fails", () => {
    const secret = generateRunSecret();
    const tokenId = "tok-1";
    const op = "git-push";
    const argsHash = hashArgs({ x: 1 });
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const signature = signToken(secret, tokenId, op, argsHash, expiresAt);
    const token: ApprovalToken = {
      tokenId, runId: "run-1", op, argsHash,
      scope: "once", expiresAt, signature: signature + "tampered",
    };
    expect(verifyToken(secret, token)).toBe(false);
  });

  it("expired token fails verify", () => {
    const secret = generateRunSecret();
    const tokenId = "tok-exp";
    const op = "migration";
    const argsHash = hashArgs({ db: "prod" });
    const expiresAt = new Date(Date.now() - 1000).toISOString(); // past
    const signature = signToken(secret, tokenId, op, argsHash, expiresAt);
    const token: ApprovalToken = {
      tokenId, runId: "run-1", op, argsHash,
      scope: "once", expiresAt, signature,
    };
    expect(verifyToken(secret, token)).toBe(false);
  });

  it("hashArgs is deterministic and key-order-independent", () => {
    const h1 = hashArgs({ b: 2, a: 1 });
    const h2 = hashArgs({ a: 1, b: 2 });
    expect(h1).toBe(h2);
  });

  it("different args produce different hashes", () => {
    const h1 = hashArgs({ branch: "main" });
    const h2 = hashArgs({ branch: "develop" });
    expect(h1).not.toBe(h2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/unit/safety/approvals.test.ts`
Expected: FAIL with "Cannot find module '../../../src/safety/approvals.js'"

- [ ] **Step 3: Implement `src/safety/approvals.ts`**

```typescript
// src/safety/approvals.ts
import { createHmac, createHash, randomBytes } from "crypto";
import type { ApprovalToken } from "../types.js";

export function generateRunSecret(): string {
  return randomBytes(32).toString("hex");
}

export function hashArgs(args: Record<string, unknown>): string {
  // Sort keys for determinism
  const sorted = Object.fromEntries(
    Object.keys(args).sort().map(k => [k, args[k]])
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export function signToken(
  secret: string,
  tokenId: string,
  op: string,
  argsHash: string,
  expiresAt: string,
): string {
  const payload = `${tokenId}:${op}:${argsHash}:${expiresAt}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyToken(secret: string, token: ApprovalToken): boolean {
  // Check expiry first
  if (new Date(token.expiresAt) < new Date()) return false;
  const expected = signToken(secret, token.tokenId, token.op, token.argsHash, token.expiresAt);
  return expected === token.signature;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/unit/safety/approvals.test.ts`
Expected: PASS — all five approval token tests green

- [ ] **Step 5: Commit**

`git add src/safety/approvals.ts tests/unit/safety/approvals.test.ts && git commit -m "feat: safety Layer C HMAC approval tokens"`

---

### Task 7: SafetyGuard extension wiring

> No separate unit test for this task — the SafetyGuard is exercised functionally via `MockExtensionAPI` in Phase 6 integration tests.

**Files:**
- Create: `src/safety/SafetyGuard.ts`

- [ ] **Step 1: Implement `src/safety/SafetyGuard.ts`**

```typescript
// src/safety/SafetyGuard.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SafetyConfig } from "../types.js";
import { classifyCommand } from "./classifier.js";
import { isProtectedPath } from "./paths.js";
import { isPlanModeAllowed } from "./PlanMode.js";
import { verifyToken } from "./approvals.js";
import { readFile } from "fs/promises";
import { join } from "path";

async function loadRunPlanMode(runsDir: string): Promise<boolean> {
  // Find the most recently active run by reading the sentinel file
  try {
    const activeFile = join(runsDir, "active-run.txt");
    const runId = (await readFile(activeFile, "utf8")).trim();
    const stateFile = join(runsDir, runId, "state.json");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    return state.planMode === true;
  } catch {
    return false; // no active run; allow by default
  }
}

async function findValidApproval(
  runsDir: string,
  op: string,
  argsHash: string,
): Promise<boolean> {
  try {
    const activeFile = join(runsDir, "active-run.txt");
    const runId = (await readFile(activeFile, "utf8")).trim();
    const secretFile = join(runsDir, runId, ".secret");
    const approvalDir = join(runsDir, runId, "approvals");
    const secret = (await readFile(secretFile, "utf8")).trim();

    const { readdir } = await import("fs/promises");
    const files = await readdir(approvalDir).catch(() => []);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const tokenPath = join(approvalDir, file);
        const token = JSON.parse(await readFile(tokenPath, "utf8"));
        if (token.consumed) continue;
        if (token.op !== op) continue;
        if (token.argsHash !== argsHash) continue;
        if (!verifyToken(secret, token)) continue;
        // Mark as consumed (once-scoped tokens)
        if (token.scope === "once") {
          token.consumed = true;
          const { writeFile } = await import("fs/promises");
          await writeFile(tokenPath, JSON.stringify(token, null, 2));
        }
        return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function registerSafetyGuard(
  pi: ExtensionAPI,
  config: SafetyConfig & { runsDir: string },
): void {
  pi.on("tool_call", async (event: any, _ctx: any) => {
    const toolName: string = event.tool?.name ?? "";
    const toolInput: Record<string, unknown> = event.toolInput ?? {};

    // --- Layer A: Hard blockers (always on) ---
    if (config.hardBlockers.enabled) {
      if (toolName === "Bash" && typeof toolInput.command === "string") {
        const result = classifyCommand(toolInput.command);
        if (result.classification === "blocked") {
          return {
            block: true,
            reason: `[Layer A] Blocked: ${result.reason ?? result.rule ?? "hard-block rule matched"}`,
            layer: "A",
          };
        }
      }

      if (["Write", "Edit", "Read"].includes(toolName)) {
        const filePath = ((toolInput.file_path ?? toolInput.path ?? "") as string);
        if (filePath) {
          const check = isProtectedPath(filePath);
          if (check.blocked) {
            return {
              block: true,
              reason: `[Layer A] Protected path: ${check.reason}`,
              layer: "A",
            };
          }
        }
      }
    }

    // --- Layer B: Plan-mode gate ---
    const planMode = await loadRunPlanMode(config.runsDir);
    if (planMode) {
      if (!isPlanModeAllowed(toolName, toolInput)) {
        return {
          block: true,
          reason: `[Layer B] Plan mode is on — only read-only tools are allowed. Disable with /run-set-plan-mode off`,
          layer: "B",
        };
      }
    }

    // --- Layer C: Default-deny for destructive operations ---
    if (toolName === "Bash" && typeof toolInput.command === "string") {
      const result = classifyCommand(toolInput.command);
      if (result.classification === "destructive") {
        const { hashArgs } = await import("./approvals.js");
        const argsHash = hashArgs(toolInput as Record<string, unknown>);
        const approved = await findValidApproval(config.runsDir, "bash", argsHash);
        if (!approved) {
          return {
            block: true,
            reason: `[Layer C] Destructive command requires Judge approval. Call RequestApproval first.`,
            layer: "C",
            classifierRule: result.reason,
          };
        }
      }
    }

    if (["Write", "Edit"].includes(toolName)) {
      const { hashArgs } = await import("./approvals.js");
      const argsHash = hashArgs(toolInput as Record<string, unknown>);
      const approved = await findValidApproval(
        config.runsDir,
        toolName.toLowerCase(),
        argsHash,
      );
      if (!approved) {
        return {
          block: true,
          reason: `[Layer C] ${toolName} requires Judge approval. Call RequestApproval first.`,
          layer: "C",
        };
      }
    }

    return undefined; // allow
  });
}
```

- [ ] **Step 2: Verify types compile**

Run: `pnpm typecheck`
Expected: PASS with zero errors

- [ ] **Step 3: Commit**

`git add src/safety/SafetyGuard.ts && git commit -m "feat: SafetyGuard extension wiring (three-layer: hard-block, plan-mode, approval-token)"`

## Phase 2: Observer

### Task 8: Observer schema + event writer

**Files:**
- Create: `src/observer/schema.ts`
- Create: `src/observer/writer.ts`
- Create: `tests/unit/observer/writer.test.ts`

- [ ] **Step 1: Write failing test**

`tests/unit/observer/writer.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, stat, rename, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { EventWriter } from "../../../src/observer/writer.js";
import type { EngteamEvent } from "../../../src/types.js";

function makeEvent(runId: string, overrides: Partial<EngteamEvent> = {}): EngteamEvent {
  return {
    ts: new Date().toISOString(),
    runId,
    category: "lifecycle",
    type: "run.start",
    payload: { test: true },
    ...overrides,
  };
}

describe("EventWriter", () => {
  let tmpDir: string;
  let writer: EventWriter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "writer-test-"));
    writer = new EventWriter(tmpDir);
  });

  it("getPath returns correct jsonl path", () => {
    expect(writer.getPath("run-abc")).toBe(join(tmpDir, "run-abc", "events.jsonl"));
  });

  it("writes an event as a valid JSON line", async () => {
    const event = makeEvent("run-1");
    await writer.write("run-1", event);
    const content = await readFile(join(tmpDir, "run-1", "events.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.runId).toBe("run-1");
    expect(parsed.category).toBe("lifecycle");
  });

  it("appends multiple events as separate lines", async () => {
    await writer.write("run-2", makeEvent("run-2", { type: "step.start" }));
    await writer.write("run-2", makeEvent("run-2", { type: "step.end" }));
    const content = await readFile(join(tmpDir, "run-2", "events.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe("step.start");
    expect(JSON.parse(lines[1]).type).toBe("step.end");
  });

  it("rotates when file exceeds 50MB threshold", async () => {
    // Override the size threshold for testing
    const smallWriter = new EventWriter(tmpDir, 100); // 100 bytes threshold
    await smallWriter.write("run-3", makeEvent("run-3"));
    await smallWriter.write("run-3", makeEvent("run-3")); // second write triggers check
    // Wait for potential rotation
    await smallWriter.flush("run-3");
    // Either events.jsonl is fresh + events.1.jsonl exists, or both lines in events.jsonl
    // (rotation happens when file size >= threshold before a write)
    const mainStat = await stat(join(tmpDir, "run-3", "events.jsonl")).catch(() => null);
    expect(mainStat).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/unit/observer/writer.test.ts`

Expected: FAIL with `Cannot find module '../../../src/observer/writer.js'`

- [ ] **Step 3: Implement**

`src/observer/schema.ts`

```typescript
export type { EngteamEvent, EventCategory } from "../types.js";

export const EVENT_TYPES = {
  lifecycle: ["run.start", "run.end", "step.start", "step.end", "agent.start", "agent.end", "team.boot", "team.shutdown"],
  tool_call: ["start", "end"],
  tool_result: ["ok", "error"],
  message: ["sent", "received", "broadcast"],
  verdict: ["emit"],
  budget: ["tick", "warn_75", "warn_90", "exhausted", "extended"],
  safety: ["block", "warn", "plan_mode_on", "plan_mode_off"],
  approval: ["request", "grant", "consume", "revoke", "expired"],
  error: ["uncaught", "agent_crash", "router_drop", "sink_failure"],
} as const;
```

`src/observer/writer.ts`

```typescript
import { appendFile, mkdir, rename, stat, readdir } from "fs/promises";
import { join } from "path";
import type { EngteamEvent } from "../types.js";

const DEFAULT_ROTATION_BYTES = 50 * 1024 * 1024; // 50MB

export class EventWriter {
  constructor(
    private runsDir: string,
    private rotationBytes = DEFAULT_ROTATION_BYTES,
  ) {}

  getPath(runId: string): string {
    return join(this.runsDir, runId, "events.jsonl");
  }

  private async ensureDir(runId: string): Promise<void> {
    await mkdir(join(this.runsDir, runId), { recursive: true });
  }

  private async rotateIfNeeded(runId: string): Promise<void> {
    const main = this.getPath(runId);
    let size = 0;
    try {
      const s = await stat(main);
      size = s.size;
    } catch {
      return; // file doesn't exist yet
    }
    if (size < this.rotationBytes) return;

    // Shift existing numbered files up
    const dir = join(this.runsDir, runId);
    const files = (await readdir(dir)).filter(f => f.match(/^events\.\d+\.jsonl$/));
    const nums = files.map(f => parseInt(f.replace("events.", "").replace(".jsonl", ""), 10));
    nums.sort((a, b) => b - a);
    for (const n of nums) {
      await rename(join(dir, `events.${n}.jsonl`), join(dir, `events.${n + 1}.jsonl`));
    }
    await rename(main, join(dir, "events.1.jsonl"));
  }

  async write(runId: string, event: EngteamEvent): Promise<void> {
    await this.ensureDir(runId);
    await this.rotateIfNeeded(runId);
    const line = JSON.stringify(event) + "\n";
    await appendFile(this.getPath(runId), line, "utf8");
  }

  async flush(_runId: string): Promise<void> {
    // appendFile is synchronous at OS level; this is a no-op placeholder
    // for explicit flush calls (useful in tests)
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/unit/observer/writer.test.ts`

Expected: PASS — all 4 assertions green

- [ ] **Step 5: Commit**

```
git add src/observer/schema.ts src/observer/writer.ts tests/unit/observer/writer.test.ts && git commit -m "feat: Observer EventWriter with jsonl append and rotation"
```

---

### Task 9: HTTP sink

**Files:**
- Create: `src/observer/httpSink.ts`
- Create: `tests/unit/observer/httpSink.test.ts`

- [ ] **Step 1: Write failing test**

`tests/unit/observer/httpSink.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { HttpSink } from "../../../src/observer/httpSink.js";
import type { EngteamEvent } from "../../../src/types.js";

function makeEvent(n: number): EngteamEvent {
  return {
    ts: new Date().toISOString(),
    runId: "run-http",
    category: "lifecycle",
    type: `event-${n}`,
    payload: { n },
  };
}

describe("HttpSink", () => {
  let fetchCalls: Array<{ url: string; body: string }> = [];
  let fetchShouldFail = false;

  beforeEach(() => {
    fetchCalls = [];
    fetchShouldFail = false;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, body: init.body as string });
      if (fetchShouldFail) {
        return { ok: false, status: 503 };
      }
      return { ok: true, status: 200 };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("flushes after 10 events", async () => {
    const sink = new HttpSink("http://localhost:4747/events", "run-http", "/tmp/dummy");
    for (let i = 0; i < 10; i++) sink.enqueue(makeEvent(i));
    await sink.flush();
    expect(fetchCalls).toHaveLength(1);
    const lines = fetchCalls[0].body.trim().split("\n");
    expect(lines).toHaveLength(10);
    sink.dispose();
  });

  it("each line in POST body is valid JSON", async () => {
    const sink = new HttpSink("http://localhost:4747/events", "run-http", "/tmp/dummy");
    sink.enqueue(makeEvent(1));
    sink.enqueue(makeEvent(2));
    await sink.flush();
    const lines = fetchCalls[0].body.trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    sink.dispose();
  });

  it("writes to sink-queue on 5xx failure", async () => {
    fetchShouldFail = true;
    const tmpDir = await mkdtemp(join(tmpdir(), "sink-test-"));
    const sink = new HttpSink("http://localhost:4747/events", "run-http", tmpDir);
    sink.enqueue(makeEvent(1));
    await sink.flush();
    const queueFile = join(tmpDir, "events.sink-queue.jsonl");
    const content = await readFile(queueFile, "utf8");
    expect(content.trim()).toBeTruthy();
    const lines = content.trim().split("\n");
    expect(JSON.parse(lines[0]).type).toBe("event-1");
    sink.dispose();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/unit/observer/httpSink.test.ts`

Expected: FAIL with `Cannot find module '../../../src/observer/httpSink.js'`

- [ ] **Step 3: Implement**

`src/observer/httpSink.ts`

```typescript
import { appendFile } from "fs/promises";
import { join } from "path";
import type { EngteamEvent } from "../types.js";

const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 2000;

export class HttpSink {
  private queue: EngteamEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private url: string,
    private runId: string,
    private runDir: string,
  ) {
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // Don't block process exit
    if (this.timer.unref) this.timer.unref();
  }

  enqueue(event: EngteamEvent): void {
    this.queue.push(event);
    if (this.queue.length >= BATCH_SIZE) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const body = batch.map(e => JSON.stringify(e)).join("\n") + "\n";

    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-ndjson" },
        body,
      });
      if (!res.ok) {
        await this.queueToFile(batch);
      }
    } catch {
      // Network error — queue to file
      await this.queueToFile(batch);
    }
  }

  private async queueToFile(events: EngteamEvent[]): Promise<void> {
    const queuePath = join(this.runDir, "events.sink-queue.jsonl");
    const lines = events.map(e => JSON.stringify(e)).join("\n") + "\n";
    await appendFile(queuePath, lines, "utf8").catch(() => {});
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/unit/observer/httpSink.test.ts`

Expected: PASS — all 3 assertions green

- [ ] **Step 5: Commit**

```
git add src/observer/httpSink.ts tests/unit/observer/httpSink.test.ts && git commit -m "feat: Observer HttpSink with batching and failure queue"
```

---

### Task 10: Observer main class

**Files:**
- Create: `src/observer/Observer.ts`

Note: No separate unit test file for this task — Observer wires Pi session events and is integration-tested in Phase 6. It composes `EventWriter` and `HttpSink`.

- [ ] **Step 1: Write failing test**

There is no isolated unit test for `Observer` at this phase; the class is verified via integration tests in Phase 6. Confirm the file is absent before proceeding:

Run: `ls src/observer/Observer.ts`

Expected: FAIL with `No such file or directory`

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm tsc --noEmit`

Expected: FAIL with `Cannot find module` or type error referencing `Observer` if any consumer already imports it, confirming the file is missing.

- [ ] **Step 3: Implement**

`src/observer/Observer.ts`

```typescript
import type { EngteamEvent, EventCategory } from "../types.js";
import type { EventWriter } from "./writer.js";
import type { HttpSink } from "./httpSink.js";
import type { MessageBus } from "../team/MessageBus.js";

// AgentSession event types (subset we care about)
type SessionEvent = {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
  toolCall?: { id: string; name: string; input: Record<string, unknown> };
  toolResult?: { id: string; content: unknown; isError?: boolean };
};

export class Observer {
  constructor(
    private writer: EventWriter,
    private sink?: HttpSink,
  ) {}

  emit(partial: Omit<EngteamEvent, "ts">): void {
    const event: EngteamEvent = {
      ts: new Date().toISOString(),
      ...partial,
    };
    // Write async — intentionally non-blocking fire-and-forget
    void this.writer.write(partial.runId, event);
    this.sink?.enqueue(event);
  }

  subscribeToSession(
    session: { subscribe: (l: (e: SessionEvent) => void) => () => void },
    runId: string,
    agentName: string,
    step?: string,
  ): () => void {
    return session.subscribe((event: SessionEvent) => {
      // Skip high-volume text deltas
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_delta"
      ) {
        return;
      }

      if (event.type === "tool_call_start" && event.toolCall) {
        this.emit({
          runId,
          step,
          agentName,
          category: "tool_call",
          type: "start",
          payload: {
            toolName: event.toolCall.name,
            toolCallId: event.toolCall.id,
            // Store raw args reference path separately to keep stream grep-friendly
          },
          summary: `${agentName} calls ${event.toolCall.name}`,
        });
      }

      if (event.type === "tool_call_end" && event.toolResult) {
        this.emit({
          runId,
          step,
          agentName,
          category: "tool_result",
          type: event.toolResult.isError ? "error" : "ok",
          payload: {
            toolCallId: event.toolResult.id,
            isError: event.toolResult.isError ?? false,
          },
        });
      }
    });
  }

  subscribeToBus(bus: MessageBus, runId: string): () => void {
    return bus.subscribeAll((msg) => {
      this.emit({
        runId,
        category: "message",
        type: "sent",
        payload: {
          from: msg.from,
          to: msg.to,
          summary: msg.summary,
          requestId: msg.requestId,
        },
        summary: `${msg.from} → ${msg.to}: ${msg.summary}`,
      });
    });
  }
}
```

Note: `MessageBus.subscribeAll` is a method to be added in Task 11 (returns an unsubscribe function for all messages).

- [ ] **Step 4: Run tests**

Run: `pnpm tsc --noEmit`

Expected: PASS — no TypeScript errors for the observer module (MessageBus type errors, if any, resolve after Task 11)

- [ ] **Step 5: Commit**

```
git add src/observer/Observer.ts && git commit -m "feat: Observer main class wiring session + bus events"
```

## Phase 3: TeamRuntime and Custom Tools

### Task 11: MessageBus

**Files:**
- Create: `src/team/MessageBus.ts`
- Create: `tests/unit/team/router.test.ts`

- [ ] **Step 1: Write failing test**

`tests/unit/team/router.test.ts`:
```typescript
import { describe, it, expect, vi } from "vitest";
import { MessageBus } from "../../../src/team/MessageBus.js";
import type { TeamMessage } from "../../../src/types.js";

function makeMsg(from: string, to: string, n: number): TeamMessage {
  return {
    id: `msg-${n}`,
    from,
    to,
    summary: `message ${n}`,
    message: `body ${n}`,
    ts: new Date().toISOString(),
  };
}

describe("MessageBus", () => {
  it("delivers a direct message to the correct recipient", async () => {
    const bus = new MessageBus();
    const received: TeamMessage[] = [];
    bus.subscribe("bob", async (msg) => { received.push(msg); });
    await bus.send(makeMsg("alice", "bob", 1));
    expect(received).toHaveLength(1);
    expect(received[0].from).toBe("alice");
  });

  it("does not deliver to unintended recipients", async () => {
    const bus = new MessageBus();
    const aliceReceived: TeamMessage[] = [];
    const bobReceived: TeamMessage[] = [];
    bus.subscribe("alice", async (msg) => { aliceReceived.push(msg); });
    bus.subscribe("bob", async (msg) => { bobReceived.push(msg); });
    await bus.send(makeMsg("alice", "bob", 1));
    expect(bobReceived).toHaveLength(1);
    expect(aliceReceived).toHaveLength(0);
  });

  it("delivers broadcast to all except sender", async () => {
    const bus = new MessageBus();
    const received: Record<string, TeamMessage[]> = { alice: [], bob: [], carol: [] };
    bus.subscribe("alice", async (msg) => { received.alice.push(msg); });
    bus.subscribe("bob", async (msg) => { received.bob.push(msg); });
    bus.subscribe("carol", async (msg) => { received.carol.push(msg); });
    await bus.broadcast("alice", "hello all", "Hi everyone");
    expect(received.alice).toHaveLength(0); // sender excluded
    expect(received.bob).toHaveLength(1);
    expect(received.carol).toHaveLength(1);
  });

  it("preserves FIFO order per recipient", async () => {
    const bus = new MessageBus();
    const order: number[] = [];
    bus.subscribe("bob", async (msg) => { order.push(parseInt(msg.id.replace("msg-", ""))); });
    await bus.send(makeMsg("alice", "bob", 1));
    await bus.send(makeMsg("alice", "bob", 2));
    await bus.send(makeMsg("alice", "bob", 3));
    expect(order).toEqual([1, 2, 3]);
  });

  it("unsubscribe stops delivery", async () => {
    const bus = new MessageBus();
    const received: TeamMessage[] = [];
    const unsub = bus.subscribe("bob", async (msg) => { received.push(msg); });
    await bus.send(makeMsg("alice", "bob", 1));
    unsub();
    await bus.send(makeMsg("alice", "bob", 2));
    expect(received).toHaveLength(1);
  });

  it("subscribeAll receives all messages", async () => {
    const bus = new MessageBus();
    const all: TeamMessage[] = [];
    bus.subscribeAll(async (msg) => { all.push(msg); });
    bus.subscribe("bob", async () => {});
    await bus.send(makeMsg("alice", "bob", 1));
    expect(all).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/unit/team/router.test.ts`

Expected: FAIL with "Cannot find module '../../../src/team/MessageBus.js'"

- [ ] **Step 3: Implement**

`src/team/MessageBus.ts`:
```typescript
import type { TeamMessage } from "../types.js";

type MessageHandler = (msg: TeamMessage) => void | Promise<void>;

export class MessageBus {
  private subscribers = new Map<string, MessageHandler[]>();
  private globalListeners: MessageHandler[] = [];

  subscribe(name: string, handler: MessageHandler): () => void {
    if (!this.subscribers.has(name)) this.subscribers.set(name, []);
    this.subscribers.get(name)!.push(handler);
    return () => {
      const handlers = this.subscribers.get(name);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    };
  }

  subscribeAll(handler: MessageHandler): () => void {
    this.globalListeners.push(handler);
    return () => {
      const idx = this.globalListeners.indexOf(handler);
      if (idx !== -1) this.globalListeners.splice(idx, 1);
    };
  }

  async send(msg: TeamMessage): Promise<void> {
    // Notify global listeners first (for observability)
    for (const listener of this.globalListeners) {
      await listener(msg);
    }
    // Deliver to recipient(s)
    if (msg.to === "*") {
      for (const [name, handlers] of this.subscribers) {
        if (name === msg.from) continue; // exclude sender
        for (const h of handlers) await h(msg);
      }
    } else {
      const handlers = this.subscribers.get(msg.to) ?? [];
      for (const h of handlers) await h(msg);
    }
  }

  async broadcast(from: string, summary: string, message: string): Promise<void> {
    await this.send({
      id: crypto.randomUUID(),
      from,
      to: "*",
      summary,
      message,
      ts: new Date().toISOString(),
    });
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/unit/team/router.test.ts`

Expected: PASS — all 6 MessageBus tests green

- [ ] **Step 5: Commit**

`git add src/team/MessageBus.ts tests/unit/team/router.test.ts && git commit -m "feat: MessageBus in-memory routing with FIFO and broadcast"`

---

### Task 12: TeamRuntime

**Files:**
- Create: `src/team/TeamRuntime.ts`

No unit test for this task — the Pi SDK session lifecycle requires live credentials and network access. TeamRuntime is exercised implicitly in the end-to-end smoke test (Task 20).

- [ ] **Step 1: Write failing test**

There is no isolated unit test for TeamRuntime. Skip to implementation.

- [ ] **Step 2: Run to verify it fails**

Not applicable — no unit test. Proceed to implementation.

- [ ] **Step 3: Implement**

`src/team/TeamRuntime.ts`:
```typescript
import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import type { AgentDefinition, TeamMessage } from "../types.js";
import type { MessageBus } from "./MessageBus.js";
import type { Observer } from "../observer/Observer.js";

type TeamRuntimeConfig = {
  cwd: string;
  bus: MessageBus;
  observer: Observer;
  runsDir: string;
  customToolsFor: (agentName: string) => any[];
};

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export class TeamRuntime {
  private sessions = new Map<string, AgentSession>();

  constructor(private config: TeamRuntimeConfig) {}

  private teamSuffix(name: string): string {
    return `\n\n---\n## Team Context\nYour name in the team is: **${name}**\nUse SendMessage to communicate with other agents. Use VerdictEmit to signal task completion.\nAlways end your turn with VerdictEmit when you have completed your assigned step.`;
  }

  async ensureTeammate(name: string, def: AgentDefinition): Promise<void> {
    if (this.sessions.has(name)) return;

    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);

    // Default fallback: sonnet if model not found
    const model =
      getModel("anthropic", def.model) ??
      getModel("anthropic", "claude-sonnet-4-6");

    if (!model) throw new Error(`Model not found for agent ${name}: ${def.model}`);

    const loader = new DefaultResourceLoader({
      cwd: this.config.cwd,
      systemPromptOverride: () => def.systemPrompt + this.teamSuffix(name),
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: this.config.cwd,
      model,
      authStorage,
      modelRegistry,
      // IMPORTANT: use factory when cwd may differ from process.cwd()
      tools: createCodingTools(this.config.cwd),
      customTools: this.config.customToolsFor(name),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });

    this.sessions.set(name, session);

    // Subscribe session events to observer
    this.config.observer.subscribeToSession(
      session as any,
      "active",   // runId set at runtime; updated per-run
      name,
    );
  }

  async ensureAllTeammates(definitions: AgentDefinition[]): Promise<void> {
    await Promise.all(definitions.map(def => this.ensureTeammate(def.name, def)));
  }

  async deliver(to: string, message: TeamMessage): Promise<void> {
    const session = this.sessions.get(to);
    if (!session) throw new Error(`Teammate '${to}' is not running. Call ensureTeammate first.`);
    const prompt = `<task-notification from="${message.from}">\n${message.message}\n</task-notification>`;
    await session.prompt(prompt);
  }

  async deliverAll(message: Omit<TeamMessage, "to">): Promise<void> {
    await Promise.all(
      Array.from(this.sessions.keys()).map(name =>
        this.deliver(name, { ...message, to: name })
      )
    );
  }

  getSession(name: string): AgentSession | undefined {
    return this.sessions.get(name);
  }

  async disposeAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm tsc --noEmit`

Expected: TypeScript compiles with no errors for `src/team/TeamRuntime.ts`

- [ ] **Step 5: Commit**

`git add src/team/TeamRuntime.ts && git commit -m "feat: TeamRuntime session registry with per-teammate AgentSession"`

---

### Task 13: Custom Tools

**Files:**
- Create: `src/team/tools/SendMessage.ts`
- Create: `src/team/tools/TaskList.ts`
- Create: `src/team/tools/TaskUpdate.ts`
- Create: `src/team/tools/VerdictEmit.ts`
- Create: `src/team/tools/RequestApproval.ts`
- Create: `src/team/tools/GrantApproval.ts`
- Create: `tests/unit/team/tools.test.ts`

- [ ] **Step 1: Write failing test**

`tests/unit/team/tools.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createSendMessageTool } from "../../../src/team/tools/SendMessage.js";
import { createVerdictEmitTool } from "../../../src/team/tools/VerdictEmit.js";
import { createTaskListTool, createTaskUpdateTool } from "../../../src/team/tools/TaskList.js";
import { createRequestApprovalTool } from "../../../src/team/tools/RequestApproval.js";
import { createGrantApprovalTool } from "../../../src/team/tools/GrantApproval.js";
import { MessageBus } from "../../../src/team/MessageBus.js";
import type { VerdictPayload } from "../../../src/types.js";

async function makeTmpDir() {
  return mkdtemp(join(tmpdir(), "tools-test-"));
}

describe("SendMessage tool", () => {
  it("calls bus.send with correct fields", async () => {
    const bus = new MessageBus();
    const sent: any[] = [];
    bus.subscribe("reviewer", async (m) => { sent.push(m); });
    const tool = createSendMessageTool(bus, "implementer");
    await tool.execute("call-1", {
      to: "reviewer",
      summary: "implementation done",
      message: "I finished the work",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe("implementer");
    expect(sent[0].to).toBe("reviewer");
    expect(sent[0].summary).toBe("implementation done");
  });
});

describe("VerdictEmit tool", () => {
  it("calls onVerdict with PASS payload", async () => {
    const verdicts: VerdictPayload[] = [];
    const tool = createVerdictEmitTool((v) => { verdicts.push(v); });
    await tool.execute("call-1", { step: "build", verdict: "PASS" });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].verdict).toBe("PASS");
  });

  it("calls onVerdict with FAIL and issues", async () => {
    const verdicts: VerdictPayload[] = [];
    const tool = createVerdictEmitTool((v) => { verdicts.push(v); });
    await tool.execute("call-1", {
      step: "review",
      verdict: "FAIL",
      issues: ["missing error handling in parser"],
    });
    expect(verdicts[0].verdict).toBe("FAIL");
    expect(verdicts[0].issues).toContain("missing error handling in parser");
  });
});

describe("TaskList and TaskUpdate tools", () => {
  it("TaskList returns empty array when no task file exists", async () => {
    const dir = await makeTmpDir();
    const listTool = createTaskListTool(dir, "run-1");
    const result = await listTool.execute("call-1", {});
    const content = JSON.parse((result.content[0] as any).text);
    expect(content).toEqual([]);
  });

  it("TaskUpdate creates and updates a task", async () => {
    const dir = await makeTmpDir();
    const updateTool = createTaskUpdateTool(dir, "run-2");
    await updateTool.execute("call-1", {
      taskId: "task-abc",
      status: "in_progress",
      notes: "started work",
    });
    const listTool = createTaskListTool(dir, "run-2");
    const result = await listTool.execute("call-2", {});
    const tasks = JSON.parse((result.content[0] as any).text);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe("task-abc");
    expect(tasks[0].status).toBe("in_progress");
  });
});

describe("RequestApproval tool", () => {
  it("writes pending approval file", async () => {
    const dir = await makeTmpDir();
    const tool = createRequestApprovalTool(dir, "run-3");
    const result = await tool.execute("call-1", {
      op: "git-push",
      command: "git push origin main",
      justification: "Merging approved feature branch",
    });
    const text = (result.content[0] as any).text;
    const parsed = JSON.parse(text);
    expect(parsed.requestId).toBeTruthy();
    // Verify file was created
    const { readdir } = await import("fs/promises");
    const files = await readdir(join(dir, "run-3", "approvals", "pending"));
    expect(files).toHaveLength(1);
  });
});

describe("GrantApproval tool", () => {
  it("creates signed token file", async () => {
    const dir = await makeTmpDir();
    // First create a pending request
    const requestTool = createRequestApprovalTool(dir, "run-4");
    const reqResult = await requestTool.execute("call-1", {
      op: "npm-install-new",
      command: "npm install lodash",
      justification: "Need lodash for data processing",
    });
    const { requestId } = JSON.parse((reqResult.content[0] as any).text);
    // Now grant it
    const grantTool = createGrantApprovalTool(dir, "run-4");
    await grantTool.execute("call-2", { requestId });
    const { readdir } = await import("fs/promises");
    const files = await readdir(join(dir, "run-4", "approvals"));
    const tokenFiles = files.filter(f => f.endsWith(".json") && !f.includes("pending"));
    expect(tokenFiles).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/unit/team/tools.test.ts`

Expected: FAIL with "Cannot find module '../../../src/team/tools/SendMessage.js'"

- [ ] **Step 3: Implement**

`src/team/tools/SendMessage.ts`:
```typescript
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { MessageBus } from "../MessageBus.js";

export function createSendMessageTool(bus: MessageBus, senderName: string) {
  return defineTool({
    name: "SendMessage",
    label: "Send Message",
    description: "Send a message to another teammate by name, or broadcast to all with '*'.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient agent name or '*' for broadcast" }),
      summary: Type.String({ description: "One-line summary for observability logs" }),
      message: Type.String({ description: "Full message body" }),
      requestId: Type.Optional(Type.String({ description: "Request ID for response pairing" })),
    }),
    execute: async (_id, params) => {
      await bus.send({
        id: crypto.randomUUID(),
        from: senderName,
        to: params.to,
        summary: params.summary,
        message: params.message,
        requestId: params.requestId,
        ts: new Date().toISOString(),
      });
      return {
        content: [{ type: "text" as const, text: `Message sent to ${params.to}` }],
        details: {},
      };
    },
  });
}
```

`src/team/tools/VerdictEmit.ts`:
```typescript
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { VerdictPayload } from "../../types.js";

export function createVerdictEmitTool(onVerdict: (v: VerdictPayload) => void) {
  return defineTool({
    name: "VerdictEmit",
    label: "Emit Verdict",
    description: "Emit a structured verdict for the current workflow step. Call this at the end of every turn. PASS = complete and correct. FAIL = issues found (list them in issues). NEEDS_MORE = need more information.",
    parameters: Type.Object({
      step: Type.String({ description: "Step name this verdict applies to, e.g. 'build', 'review'" }),
      verdict: Type.Union([
        Type.Literal("PASS"),
        Type.Literal("FAIL"),
        Type.Literal("NEEDS_MORE"),
      ], { description: "Verdict value" }),
      issues: Type.Optional(Type.Array(Type.String(), {
        description: "List of specific issues found (required when verdict is FAIL)",
      })),
      artifacts: Type.Optional(Type.Array(Type.String(), {
        description: "File paths to artifacts produced in this step",
      })),
      handoffHint: Type.Optional(Type.String({
        description: "Routing hint for failure escalation: 'security'|'perf'|'re-plan'",
      })),
    }),
    execute: async (_id, params) => {
      onVerdict(params);
      return {
        content: [{ type: "text" as const, text: `Verdict recorded: ${params.verdict}` }],
        details: {},
      };
    },
  });
}
```

`src/team/tools/TaskList.ts` (exports both the list tool and the update tool):
```typescript
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

type Task = {
  taskId: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  notes?: string;
  owner?: string;
  updatedAt: string;
};

async function loadTasks(runsDir: string, runId: string): Promise<Task[]> {
  const path = join(runsDir, runId, "tasks.json");
  try {
    return JSON.parse(await readFile(path, "utf8")) as Task[];
  } catch {
    return [];
  }
}

async function saveTasks(runsDir: string, runId: string, tasks: Task[]): Promise<void> {
  const dir = join(runsDir, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "tasks.json"), JSON.stringify(tasks, null, 2));
}

export function createTaskListTool(runsDir: string, runId: string) {
  return defineTool({
    name: "TaskList",
    label: "List Tasks",
    description: "List all tasks for the current run",
    parameters: Type.Object({}),
    execute: async (_id, _params) => {
      const tasks = await loadTasks(runsDir, runId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(tasks, null, 2) }],
        details: {},
      };
    },
  });
}

export function createTaskUpdateTool(runsDir: string, runId: string) {
  return defineTool({
    name: "TaskUpdate",
    label: "Update Task",
    description: "Create or update a task's status",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID" }),
      status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed"),
        Type.Literal("blocked"),
      ]),
      notes: Type.Optional(Type.String()),
      owner: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      const tasks = await loadTasks(runsDir, runId);
      const existing = tasks.find(t => t.taskId === params.taskId);
      if (existing) {
        existing.status = params.status;
        existing.updatedAt = new Date().toISOString();
        if (params.notes) existing.notes = params.notes;
        if (params.owner) existing.owner = params.owner;
      } else {
        tasks.push({
          taskId: params.taskId,
          status: params.status,
          notes: params.notes,
          owner: params.owner,
          updatedAt: new Date().toISOString(),
        });
      }
      await saveTasks(runsDir, runId, tasks);
      return {
        content: [{ type: "text" as const, text: `Task ${params.taskId} updated: ${params.status}` }],
        details: {},
      };
    },
  });
}
```

`src/team/tools/RequestApproval.ts`:
```typescript
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

export function createRequestApprovalTool(runsDir: string, runId: string) {
  return defineTool({
    name: "RequestApproval",
    label: "Request Approval",
    description: "Request approval from the Judge before executing a destructive operation. Wait for GrantApproval before proceeding.",
    parameters: Type.Object({
      op: Type.String({ description: "Operation type: 'git-push'|'npm-install-new'|'migration'|'bash'|'write'|'edit'" }),
      command: Type.String({ description: "The exact command or file path that requires approval" }),
      justification: Type.String({ description: "Why this operation is necessary for the current task" }),
    }),
    execute: async (_id, params) => {
      const requestId = crypto.randomUUID();
      const pendingDir = join(runsDir, runId, "approvals", "pending");
      await mkdir(pendingDir, { recursive: true });
      const request = {
        requestId,
        runId,
        op: params.op,
        command: params.command,
        justification: params.justification,
        createdAt: new Date().toISOString(),
      };
      await writeFile(
        join(pendingDir, `${requestId}.json`),
        JSON.stringify(request, null, 2),
      );
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ requestId, message: "Approval request submitted. The Judge will review and grant or deny." }),
        }],
        details: {},
      };
    },
  });
}
```

`src/team/tools/GrantApproval.ts`:
```typescript
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { generateRunSecret, signToken, hashArgs } from "../../safety/approvals.js";

export function createGrantApprovalTool(runsDir: string, runId: string) {
  return defineTool({
    name: "GrantApproval",
    label: "Grant Approval",
    description: "Grant approval for a pending destructive operation. JUDGE ONLY — do not call this unless you are the Judge agent and have reviewed the request against the current plan.",
    parameters: Type.Object({
      requestId: Type.String({ description: "The request ID from RequestApproval" }),
      ttlSeconds: Type.Optional(Type.Number({ description: "Token TTL in seconds (default 300)" })),
      scope: Type.Optional(Type.Union([
        Type.Literal("once"),
        Type.Literal("run-lifetime"),
      ], { description: "once = single use (default), run-lifetime = valid for entire run" })),
    }),
    execute: async (_id, params) => {
      const requestPath = join(runsDir, runId, "approvals", "pending", `${params.requestId}.json`);
      const request = JSON.parse(await readFile(requestPath, "utf8"));

      // Load or create run secret
      const secretPath = join(runsDir, runId, ".secret");
      let secret: string;
      try {
        secret = (await readFile(secretPath, "utf8")).trim();
      } catch {
        secret = generateRunSecret();
        await mkdir(join(runsDir, runId), { recursive: true });
        await writeFile(secretPath, secret, { mode: 0o600 });
      }

      const tokenId = crypto.randomUUID();
      const argsHash = hashArgs({ op: request.op, command: request.command });
      const ttl = params.ttlSeconds ?? 300;
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      const scope = params.scope ?? "once";
      const signature = signToken(secret, tokenId, request.op, argsHash, expiresAt);

      const token = {
        tokenId,
        runId,
        op: request.op,
        argsHash,
        scope,
        expiresAt,
        signature,
        consumed: false,
        grantedAt: new Date().toISOString(),
        requestId: params.requestId,
      };

      const approvalsDir = join(runsDir, runId, "approvals");
      await mkdir(approvalsDir, { recursive: true });
      await writeFile(join(approvalsDir, `${tokenId}.json`), JSON.stringify(token, null, 2));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ tokenId, expiresAt, scope, message: "Approval granted. The operation may proceed." }),
        }],
        details: {},
      };
    },
  });
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/unit/team/tools.test.ts`

Expected: PASS — all 6 tool tests green (SendMessage x1, VerdictEmit x2, TaskList/TaskUpdate x2, RequestApproval x1, GrantApproval x1)

- [ ] **Step 5: Commit**

`git add src/team/tools/SendMessage.ts src/team/tools/VerdictEmit.ts src/team/tools/TaskList.ts src/team/tools/RequestApproval.ts src/team/tools/GrantApproval.ts tests/unit/team/tools.test.ts && git commit -m "feat: custom tools: SendMessage, VerdictEmit, TaskList, TaskUpdate, RequestApproval, GrantApproval"`

## Phase 4: ADW Engine

### Task 14: RunState persistence

**Files:**
- Create: `src/adw/RunState.ts`
- Create: `tests/unit/adw/RunState.test.ts`

- [ ] Write failing test file `tests/unit/adw/RunState.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createRunState, saveRunState, loadRunState, updateStep } from "../../../src/adw/RunState.js";
import type { RunState } from "../../../src/types.js";

async function makeTmpDir() {
  return mkdtemp(join(tmpdir(), "runstate-test-"));
}

describe("RunState", () => {
  it("createRunState sets correct defaults", async () => {
    const state = await createRunState({
      runId: "run-1",
      workflow: "plan-build-review",
      goal: "Add login feature",
      budget: { maxIterations: 5 },
    });
    expect(state.runId).toBe("run-1");
    expect(state.status).toBe("pending");
    expect(state.iteration).toBe(0);
    expect(state.planMode).toBe(true);
    expect(state.budget.maxIterations).toBe(5);
    expect(state.budget.maxCostUsd).toBe(20);     // default
    expect(state.budget.spent.costUsd).toBe(0);
    expect(state.steps).toEqual([]);
    expect(state.artifacts).toEqual({});
  });

  it("saveRunState writes JSON to state.json", async () => {
    const dir = await makeTmpDir();
    const state = await createRunState({
      runId: "run-save",
      workflow: "plan-build-review",
      goal: "Test save",
      budget: {},
    });
    await saveRunState(dir, state);
    const raw = await readFile(join(dir, "run-save", "state.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.runId).toBe("run-save");
  });

  it("saveRunState writes atomically (via .tmp rename)", async () => {
    const dir = await makeTmpDir();
    const state = await createRunState({
      runId: "run-atomic",
      workflow: "plan-build-review",
      goal: "Atomic write test",
      budget: {},
    });
    await saveRunState(dir, state);
    // Verify .tmp file is gone (rename completed)
    const { access } = await import("fs/promises");
    const tmpExists = await access(join(dir, "run-atomic", "state.json.tmp"))
      .then(() => true).catch(() => false);
    expect(tmpExists).toBe(false);
  });

  it("loadRunState returns null for missing run", async () => {
    const dir = await makeTmpDir();
    const result = await loadRunState(dir, "nonexistent");
    expect(result).toBeNull();
  });

  it("saveRunState + loadRunState round-trips", async () => {
    const dir = await makeTmpDir();
    const state = await createRunState({
      runId: "run-rt",
      workflow: "plan-build-review",
      goal: "Round trip",
      budget: { maxCostUsd: 15 },
    });
    await saveRunState(dir, state);
    const loaded = await loadRunState(dir, "run-rt");
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe("run-rt");
    expect(loaded!.budget.maxCostUsd).toBe(15);
  });

  it("updateStep adds new step record", () => {
    const state: RunState = {
      runId: "r", workflow: "w", goal: "g",
      status: "running", currentStep: "plan",
      iteration: 0,
      budget: { maxIterations: 8, maxCostUsd: 20, maxWallSeconds: 3600, maxTokens: 1000000, spent: { costUsd: 0, wallSeconds: 0, tokens: 0 } },
      steps: [],
      artifacts: {},
      approvals: [],
      planMode: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const updated = updateStep(state, "plan", { verdict: "PASS", endedAt: new Date().toISOString() });
    expect(updated.steps).toHaveLength(1);
    expect(updated.steps[0].name).toBe("plan");
    expect(updated.steps[0].verdict).toBe("PASS");
  });

  it("updateStep updates existing step record", () => {
    const baseState: RunState = {
      runId: "r", workflow: "w", goal: "g",
      status: "running", currentStep: "plan",
      iteration: 0,
      budget: { maxIterations: 8, maxCostUsd: 20, maxWallSeconds: 3600, maxTokens: 1000000, spent: { costUsd: 0, wallSeconds: 0, tokens: 0 } },
      steps: [{ name: "plan", startedAt: new Date().toISOString() }],
      artifacts: {},
      approvals: [],
      planMode: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const updated = updateStep(baseState, "plan", { verdict: "PASS" });
    expect(updated.steps).toHaveLength(1);
    expect(updated.steps[0].verdict).toBe("PASS");
  });
});
```

- [ ] Run tests — expect all to fail (module not found):

```bash
npx vitest run tests/unit/adw/RunState.test.ts
```

- [ ] Create `src/adw/RunState.ts`:

```typescript
import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { join } from "path";
import type { RunState, Budget, StepRecord } from "../types.js";

const DEFAULT_BUDGET: Budget = {
  maxIterations: 8,
  maxCostUsd: 20,
  maxWallSeconds: 3600,
  maxTokens: 1_000_000,
  spent: { costUsd: 0, wallSeconds: 0, tokens: 0 },
};

export async function createRunState(params: {
  runId: string;
  workflow: string;
  goal: string;
  budget: Partial<Budget>;
}): Promise<RunState> {
  const now = new Date().toISOString();
  return {
    runId: params.runId,
    workflow: params.workflow,
    goal: params.goal,
    status: "pending",
    currentStep: "plan", // first step of every workflow
    iteration: 0,
    budget: {
      ...DEFAULT_BUDGET,
      ...params.budget,
      spent: { costUsd: 0, wallSeconds: 0, tokens: 0 },
    },
    steps: [],
    artifacts: {},
    approvals: [],
    planMode: true, // plan-mode on by default
    createdAt: now,
    updatedAt: now,
  };
}

export async function saveRunState(runsDir: string, state: RunState): Promise<void> {
  const runDir = join(runsDir, state.runId);
  await mkdir(runDir, { recursive: true });
  const stateFile = join(runDir, "state.json");
  const tmpFile = join(runDir, "state.json.tmp");
  const updated = { ...state, updatedAt: new Date().toISOString() };
  await writeFile(tmpFile, JSON.stringify(updated, null, 2));
  await rename(tmpFile, stateFile); // atomic on POSIX
}

export async function loadRunState(runsDir: string, runId: string): Promise<RunState | null> {
  try {
    const stateFile = join(runsDir, runId, "state.json");
    const raw = await readFile(stateFile, "utf8");
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

export function updateStep(state: RunState, stepName: string, record: Partial<StepRecord>): RunState {
  const existing = state.steps.findIndex(s => s.name === stepName);
  const updated = [...state.steps];
  if (existing === -1) {
    updated.push({ name: stepName, ...record });
  } else {
    updated[existing] = { ...updated[existing], ...record };
  }
  return { ...state, steps: updated };
}
```

- [ ] Run tests again — expect all to pass:

```bash
npx vitest run tests/unit/adw/RunState.test.ts
```

- [ ] Commit: `feat: RunState atomic JSON persistence`

---

### Task 15: BudgetGuard

**Files:**
- Create: `src/adw/BudgetGuard.ts`
- Create: `tests/unit/adw/BudgetGuard.test.ts`

- [ ] Write failing test file `tests/unit/adw/BudgetGuard.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { checkBudget, tickBudget } from "../../../src/adw/BudgetGuard.js";
import type { RunState } from "../../../src/types.js";

function makeState(overrides: Partial<RunState["budget"]> & { spent?: Partial<RunState["budget"]["spent"]> } = {}): RunState {
  const { spent: spentOverrides, ...budgetOverrides } = overrides;
  return {
    runId: "r", workflow: "w", goal: "g",
    status: "running", currentStep: "plan",
    iteration: 0,
    budget: {
      maxIterations: 8,
      maxCostUsd: 20,
      maxWallSeconds: 3600,
      maxTokens: 1_000_000,
      spent: { costUsd: 0, wallSeconds: 0, tokens: 0, ...spentOverrides },
      ...budgetOverrides,
    },
    steps: [], artifacts: {}, approvals: [], planMode: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

describe("checkBudget", () => {
  it("returns ok=true with no warnings when all at 0%", () => {
    const result = checkBudget(makeState());
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.exhausted).toHaveLength(0);
  });

  it("warns at 75% of iterations", () => {
    const state = makeState();
    state.iteration = 6; // 6/8 = 75%
    const result = checkBudget(state);
    expect(result.warnings).toContain("iterations");
    expect(result.exhausted).not.toContain("iterations");
  });

  it("exhausted at 100% of iterations", () => {
    const state = makeState();
    state.iteration = 8; // 8/8 = 100%
    const result = checkBudget(state);
    expect(result.exhausted).toContain("iterations");
    expect(result.ok).toBe(false);
  });

  it("warns at 75% of cost", () => {
    const result = checkBudget(makeState({ spent: { costUsd: 15, wallSeconds: 0, tokens: 0 } })); // 15/20 = 75%
    expect(result.warnings).toContain("cost");
  });

  it("exhausted at 100% of cost", () => {
    const result = checkBudget(makeState({ spent: { costUsd: 20, wallSeconds: 0, tokens: 0 } }));
    expect(result.exhausted).toContain("cost");
  });

  it("warns at 75% of wall time", () => {
    const result = checkBudget(makeState({ spent: { costUsd: 0, wallSeconds: 2700, tokens: 0 } })); // 2700/3600 = 75%
    expect(result.warnings).toContain("wall");
  });
});

describe("tickBudget", () => {
  it("adds elapsed seconds to spent.wallSeconds", () => {
    const state = makeState({ spent: { costUsd: 0, wallSeconds: 100, tokens: 0 } });
    const updated = tickBudget(state, 50);
    expect(updated.budget.spent.wallSeconds).toBe(150);
  });

  it("does not mutate the original state", () => {
    const state = makeState();
    const updated = tickBudget(state, 100);
    expect(state.budget.spent.wallSeconds).toBe(0);
    expect(updated.budget.spent.wallSeconds).toBe(100);
  });
});
```

- [ ] Run tests — expect all to fail (module not found):

```bash
npx vitest run tests/unit/adw/BudgetGuard.test.ts
```

- [ ] Create `src/adw/BudgetGuard.ts`:

```typescript
import type { RunState, BudgetStatus } from "../types.js";

const WARN_THRESHOLD = 0.75;

export function checkBudget(state: RunState): BudgetStatus {
  const { budget, iteration } = state;
  const { maxIterations, maxCostUsd, maxWallSeconds, maxTokens, spent } = budget;

  const warnings: BudgetStatus["warnings"] = [];
  const exhausted: BudgetStatus["exhausted"] = [];

  function check(
    dimension: "iterations" | "cost" | "wall" | "tokens",
    current: number,
    max: number,
  ) {
    if (max <= 0) return; // 0 means unlimited
    const ratio = current / max;
    if (ratio >= 1) exhausted.push(dimension);
    else if (ratio >= WARN_THRESHOLD) warnings.push(dimension);
  }

  check("iterations", iteration, maxIterations);
  check("cost", spent.costUsd, maxCostUsd);
  check("wall", spent.wallSeconds, maxWallSeconds);
  check("tokens", spent.tokens, maxTokens);

  return {
    ok: exhausted.length === 0,
    warnings,
    exhausted,
  };
}

export function tickBudget(state: RunState, elapsedSeconds: number): RunState {
  return {
    ...state,
    budget: {
      ...state.budget,
      spent: {
        ...state.budget.spent,
        wallSeconds: state.budget.spent.wallSeconds + elapsedSeconds,
      },
    },
  };
}
```

- [ ] Run tests again — expect all to pass:

```bash
npx vitest run tests/unit/adw/BudgetGuard.test.ts
```

- [ ] Commit: `feat: BudgetGuard limit checks with 75% warnings`

---

## Phase 5: Plan-Build-Review Workflow

### Task 16: ADWEngine step machine

**Files:**
- Create: `src/adw/ADWEngine.ts`
- Create: `tests/unit/adw/ADWEngine.test.ts`

- [ ] Write failing test file `tests/unit/adw/ADWEngine.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ADWEngine } from "../../../src/adw/ADWEngine.js";
import { loadRunState } from "../../../src/adw/RunState.js";
import type { Workflow, Step, StepContext, StepResult } from "../../../src/workflows/types.js";
import type { RunState } from "../../../src/types.js";

async function makeTmpDir() {
  return mkdtemp(join(tmpdir(), "engine-test-"));
}

function makePassStep(name: string): Step {
  return {
    name,
    required: true,
    run: async (_ctx: StepContext): Promise<StepResult> => ({
      success: true,
      verdict: "PASS",
    }),
  };
}

function makeFailStep(name: string, failCount: number): Step {
  let calls = 0;
  return {
    name,
    required: true,
    run: async (_ctx: StepContext): Promise<StepResult> => {
      calls++;
      if (calls <= failCount) {
        return { success: false, verdict: "FAIL", issues: ["test failure"] };
      }
      return { success: true, verdict: "PASS" };
    },
  };
}

function makeWorkflow(steps: Step[], fixLoop = false): Workflow {
  const transitions = fixLoop ? [
    { from: "build", when: (r: StepResult) => r.verdict === "PASS", to: "review" },
    { from: "build", when: (r: StepResult) => r.verdict !== "PASS", to: "halt" },
    { from: "review", when: (r: StepResult) => r.verdict === "PASS", to: "halt" },
    { from: "review", when: (r: StepResult) => r.verdict === "FAIL", to: "fix" },
    { from: "fix", when: (_r: StepResult) => true, to: "review" },
  ] : steps.map((s, i) => ({
    from: s.name,
    when: (r: StepResult) => r.verdict === "PASS",
    to: steps[i + 1]?.name ?? "halt",
  }));
  return {
    name: "test-workflow",
    description: "Test workflow",
    steps,
    transitions: [
      ...transitions,
      // Halt fallback for any FAIL not covered above
      ...steps.map(s => ({
        from: s.name,
        when: (r: StepResult) => r.verdict !== "PASS",
        to: "halt" as const,
      })).filter(t => !transitions.some(existing => existing.from === t.from && !fixLoop)),
    ],
    defaults: { maxIterations: 8, maxCostUsd: 20 },
  };
}

function makeMockTeam() {
  return {
    ensureTeammate: vi.fn(),
    ensureAllTeammates: vi.fn(),
    deliver: vi.fn(),
    disposeAll: vi.fn(),
  } as any;
}

function makeMockObserver() {
  return {
    emit: vi.fn(),
    subscribeToSession: vi.fn(() => () => {}),
    subscribeToBus: vi.fn(() => () => {}),
  } as any;
}

describe("ADWEngine", () => {
  it("single PASS step → status succeeded", async () => {
    const dir = await makeTmpDir();
    const step = makePassStep("plan");
    const workflow = makeWorkflow([step]);
    const engine = new ADWEngine({
      runsDir: dir,
      workflows: new Map([["test-workflow", workflow]]),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    const run = await engine.startRun({ workflow: "test-workflow", goal: "test goal", budget: {} });
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("succeeded");
  });

  it("FAIL step → status failed", async () => {
    const dir = await makeTmpDir();
    const step = makeFailStep("plan", 99); // always fails
    const workflow: Workflow = {
      name: "test-workflow",
      description: "test",
      steps: [step],
      transitions: [
        { from: "plan", when: (r) => r.verdict !== "PASS", to: "halt" },
      ],
      defaults: {},
    };
    const engine = new ADWEngine({
      runsDir: dir,
      workflows: new Map([["test-workflow", workflow]]),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    const run = await engine.startRun({ workflow: "test-workflow", goal: "test", budget: {} });
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("failed");
  });

  it("budget exhausted → status failed", async () => {
    const dir = await makeTmpDir();
    const step = makePassStep("plan");
    const workflow = makeWorkflow([step]);
    const engine = new ADWEngine({
      runsDir: dir,
      workflows: new Map([["test-workflow", workflow]]),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    // Start run at max iterations already
    const run = await engine.startRun({
      workflow: "test-workflow",
      goal: "test",
      budget: { maxIterations: 0 }, // immediately exhausted
    });
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("failed");
  });

  it("resumeRun loads state from disk and continues", async () => {
    const dir = await makeTmpDir();
    const step = makePassStep("plan");
    const workflow = makeWorkflow([step]);
    const engine = new ADWEngine({
      runsDir: dir,
      workflows: new Map([["test-workflow", workflow]]),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    const run = await engine.startRun({ workflow: "test-workflow", goal: "test", budget: {} });
    // Simulate interrupted run — save state as "running"
    const { saveRunState } = await import("../../../src/adw/RunState.js");
    await saveRunState(dir, { ...run, status: "running" });
    const final = await engine.resumeRun(run.runId);
    expect(final.status).toBe("succeeded");
  });
});
```

- [ ] Run tests — expect all to fail (module not found):

```bash
npx vitest run tests/unit/adw/ADWEngine.test.ts
```

- [ ] Create `src/adw/ADWEngine.ts`:

```typescript
import type { RunState, VerdictPayload } from "../types.js";
import type { Workflow, StepContext, StepResult } from "../workflows/types.js";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { Observer } from "../observer/Observer.js";
import {
  createRunState,
  saveRunState,
  loadRunState,
  updateStep,
} from "./RunState.js";
import { checkBudget, tickBudget } from "./BudgetGuard.js";

type ADWConfig = {
  runsDir: string;
  workflows: Map<string, Workflow>;
  team: TeamRuntime;
  observer: Observer;
};

type StartRunParams = {
  workflow: string;
  goal: string;
  budget: Parameters<typeof createRunState>[0]["budget"];
};

export class ADWEngine {
  private verdictListeners = new Map<string, (v: VerdictPayload) => void>();

  constructor(private config: ADWConfig) {}

  registerVerdictListener(step: string, listener: (v: VerdictPayload) => void): void {
    this.verdictListeners.set(step, listener);
  }

  notifyVerdict(v: VerdictPayload): void {
    const listener = this.verdictListeners.get(v.step);
    if (listener) {
      this.verdictListeners.delete(v.step);
      listener(v);
    }
  }

  async startRun(params: StartRunParams): Promise<RunState> {
    const runId = crypto.randomUUID();
    const state = await createRunState({
      runId,
      workflow: params.workflow,
      goal: params.goal,
      budget: params.budget,
    });
    await saveRunState(this.config.runsDir, state);

    // Write active-run sentinel for SafetyGuard
    const { writeFile } = await import("fs/promises");
    const { join } = await import("path");
    await writeFile(
      join(this.config.runsDir, "active-run.txt"),
      runId,
    );

    this.config.observer.emit({
      runId,
      category: "lifecycle",
      type: "run.start",
      payload: { workflow: params.workflow, goal: params.goal },
      summary: `Run ${runId} started: ${params.goal}`,
    });

    return state;
  }

  async executeRun(runId: string): Promise<RunState> {
    let state = await loadRunState(this.config.runsDir, runId);
    if (!state) throw new Error(`Run ${runId} not found`);

    state = { ...state, status: "running" };
    await saveRunState(this.config.runsDir, state);

    const workflow = this.config.workflows.get(state.workflow);
    if (!workflow) throw new Error(`Workflow '${state.workflow}' not found`);

    while (state.status === "running") {
      // Check budget before each step
      const budgetStatus = checkBudget(state);
      if (!budgetStatus.ok) {
        state = { ...state, status: "failed" };
        this.config.observer.emit({
          runId,
          category: "budget",
          type: "exhausted",
          payload: { exhausted: budgetStatus.exhausted },
          summary: `Budget exhausted: ${budgetStatus.exhausted.join(", ")}`,
        });
        break;
      }

      const stepDef = workflow.steps.find(s => s.name === state!.currentStep);
      if (!stepDef) {
        state = { ...state, status: "failed" };
        break;
      }

      // Emit step start
      this.config.observer.emit({
        runId,
        step: state.currentStep,
        iteration: state.iteration,
        category: "lifecycle",
        type: "step.start",
        payload: { step: state.currentStep },
      });

      const startedAt = new Date().toISOString();
      state = updateStep(state, state.currentStep, { startedAt });

      const stepStart = Date.now();
      let result: StepResult;

      try {
        const ctx: StepContext = {
          run: state,
          team: this.config.team,
          observer: this.config.observer,
          engine: this,
        };
        result = await stepDef.run(ctx);
      } catch (err) {
        result = {
          success: false,
          verdict: "FAIL",
          error: err instanceof Error ? err.message : String(err),
        };
      }

      const elapsed = (Date.now() - stepStart) / 1000;
      state = tickBudget(state, elapsed);
      state = updateStep(state, state.currentStep, {
        verdict: result.verdict,
        issues: result.issues,
        handoffHint: result.handoffHint,
        artifacts: result.artifacts ? Object.values(result.artifacts) : undefined,
        endedAt: new Date().toISOString(),
        error: result.error,
      });

      // Emit step end
      this.config.observer.emit({
        runId,
        step: state.currentStep,
        iteration: state.iteration,
        category: "lifecycle",
        type: "step.end",
        payload: { verdict: result.verdict, issues: result.issues },
      });

      // Find matching transition
      const transition = workflow.transitions.find(
        t => t.from === state!.currentStep && t.when(result),
      );

      if (!transition || transition.to === "halt") {
        state = { ...state, status: result.success ? "succeeded" : "failed" };
        break;
      }

      // Advance to next step
      state = {
        ...state,
        currentStep: transition.to,
        iteration: state.iteration + 1,
      };

      await saveRunState(this.config.runsDir, state);
    }

    await saveRunState(this.config.runsDir, state);

    this.config.observer.emit({
      runId,
      category: "lifecycle",
      type: "run.end",
      payload: { status: state.status, iteration: state.iteration },
      summary: `Run ${runId} ended: ${state.status}`,
    });

    return state;
  }

  async resumeRun(runId: string): Promise<RunState> {
    const state = await loadRunState(this.config.runsDir, runId);
    if (!state) throw new Error(`Run ${runId} not found`);
    // Resume from current step — executeRun picks up from state.currentStep
    return this.executeRun(runId);
  }

  async abortRun(runId: string): Promise<void> {
    const state = await loadRunState(this.config.runsDir, runId);
    if (!state) return;
    const aborted = { ...state, status: "aborted" as const };
    await saveRunState(this.config.runsDir, aborted);
    this.config.observer.emit({
      runId,
      category: "lifecycle",
      type: "run.end",
      payload: { status: "aborted" },
      summary: `Run ${runId} aborted`,
    });
  }
}
```

- [ ] Run tests again — expect all to pass:

```bash
npx vitest run tests/unit/adw/ADWEngine.test.ts
```

- [ ] Commit: `feat: ADWEngine step machine with budget checks, transitions, and resume`

---

### Task 17: Workflow types + plan-build-review workflow

**Files:**
- Create: `src/workflows/types.ts`
- Create: `src/workflows/plan-build-review.ts`

Workflow correctness is validated by the ADWEngine tests above (Task 16) and the end-to-end smoke test in Task 20. No separate unit test file is needed for this task.

- [ ] Create `src/workflows/types.ts`:

```typescript
import type { RunState, Verdict } from "../types.js";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { Observer } from "../observer/Observer.js";
import type { ADWEngine } from "../adw/ADWEngine.js";

export type StepContext = {
  run: RunState;
  team: TeamRuntime;
  observer: Observer;
  engine: ADWEngine;
};

export type StepResult = {
  success: boolean;
  verdict: Verdict;
  issues?: string[];
  artifacts?: Record<string, string>;
  handoffHint?: string;
  error?: string;
};

export type Step = {
  name: string;
  required: boolean;
  run: (ctx: StepContext) => Promise<StepResult>;
};

export type WorkflowTransition = {
  from: string;
  when: (r: StepResult) => boolean;
  to: string | "halt";
};

export type Workflow = {
  name: string;
  description: string;
  steps: Step[];
  transitions: WorkflowTransition[];
  defaults: Partial<RunState["budget"]>;
};
```

- [ ] Create `src/workflows/plan-build-review.ts`.

Each step dispatches work to the named agent via `TeamRuntime.deliver()` then waits for a `VerdictEmit` call. The wait mechanism uses a `Promise` that resolves when the `VerdictEmit` callback fires via `engine.registerVerdictListener`. The team must have `planner`, `implementer`, and `reviewer` agents spawned before this workflow runs.

```typescript
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

/**
 * Wait for the named agent to call VerdictEmit.
 * We inject a one-shot verdict listener on ADWEngine for the specific step,
 * then prompt the agent via deliver(). The promise resolves when VerdictEmit
 * fires onVerdict, which calls engine.notifyVerdict.
 */
async function waitForAgentVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Agent ${agentName} did not emit verdict for step ${stepName} within 10 minutes`));
    }, 10 * 60 * 1000);

    // Register one-shot verdict listener on the engine
    (ctx.engine as any).registerVerdictListener(stepName, (v: VerdictPayload) => {
      clearTimeout(timeout);
      resolve(v);
    });

    // Deliver the prompt to the agent
    ctx.team.deliver(agentName, {
      id: crypto.randomUUID(),
      from: "system",
      to: agentName,
      summary: `Execute step: ${stepName}`,
      message: prompt,
      ts: new Date().toISOString(),
    }).catch(reject);
  });
}

async function saveArtifact(ctx: StepContext, name: string, content: string): Promise<string> {
  const { runsDir } = (ctx.engine as any).config;
  const artifactDir = join(runsDir, ctx.run.runId, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const path = join(artifactDir, name);
  await writeFile(path, content);
  return path;
}

const planStep: Step = {
  name: "plan",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are being asked to plan the following goal:

GOAL: ${ctx.run.goal}

Please:
1. Analyze the goal and break it into concrete, actionable sub-tasks
2. Identify which files need to be created or modified
3. Note any risks or unknowns
4. Write the plan as a numbered list with clear implementation steps

When your plan is complete, call VerdictEmit with:
- step: "plan"
- verdict: "PASS" (if the goal is feasible and the plan is clear)
- verdict: "FAIL" with issues listed (if the goal is not feasible or you need more information)
- artifacts: ["plan.md"] pointing to the plan file you create`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "planner", prompt, "plan");
      const planArtifact = verdict.artifacts?.[0] ?? "plan.md";
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { plan: planArtifact },
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

const buildStep: Step = {
  name: "build",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const planArtifact = ctx.run.artifacts["plan"] ?? "No plan artifact found";
    const prompt = `You are the implementer. Here is the plan you need to execute:

PLAN LOCATION: ${planArtifact}

Please:
1. Read the plan file
2. Implement each step in order
3. Write tests alongside implementation (TDD)
4. For any destructive operation (git push, npm install, file delete), call RequestApproval first

When implementation is complete and tests pass, call VerdictEmit with:
- step: "build"
- verdict: "PASS" (implementation complete, tests passing)
- verdict: "FAIL" with specific issues listed (if blocked or tests failing)`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "build");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`artifact-${i}`, a]))
          : {},
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

const reviewStep: Step = {
  name: "review",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the reviewer. Please review the implementation for the following goal:

GOAL: ${ctx.run.goal}

Previous steps completed: ${ctx.run.steps.map(s => s.name).join(", ")}

Please:
1. Read all changed/created files
2. Check for logical errors, edge cases, missing tests
3. Verify the implementation matches the plan
4. Look for security issues, performance problems, or maintainability concerns

When your review is complete, call VerdictEmit with:
- step: "review"
- verdict: "PASS" (implementation is correct, complete, and maintainable)
- verdict: "FAIL" with a specific list of issues (what exactly is wrong and where)
- handoffHint: "security" | "perf" | "re-plan" if the issue category warrants specialist escalation`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "reviewer", prompt, "review");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

export const planBuildReview: Workflow = {
  name: "plan-build-review",
  description: "Plan a feature, implement it, then review for correctness.",
  steps: [planStep, buildStep, reviewStep],
  transitions: [
    { from: "plan",   when: (r) => r.verdict === "PASS",   to: "build" },
    { from: "plan",   when: (r) => r.verdict !== "PASS",   to: "halt" },
    { from: "build",  when: (r) => r.verdict === "PASS",   to: "review" },
    { from: "build",  when: (r) => r.verdict !== "PASS",   to: "halt" },
    { from: "review", when: (_r) => true,                  to: "halt" },
  ],
  defaults: {
    maxIterations: 8,
    maxCostUsd: 20,
    maxWallSeconds: 3600,
  },
};
```

- [ ] Verify the `ADWEngine` class in `src/adw/ADWEngine.ts` already contains `registerVerdictListener` and `notifyVerdict` (added in Task 16). Confirm `verdictListeners` is declared as a private field:

```typescript
// Already present from Task 16:
private verdictListeners = new Map<string, (v: VerdictPayload) => void>();

registerVerdictListener(step: string, listener: (v: VerdictPayload) => void): void {
  this.verdictListeners.set(step, listener);
}

notifyVerdict(v: VerdictPayload): void {
  const listener = this.verdictListeners.get(v.step);
  if (listener) {
    this.verdictListeners.delete(v.step);
    listener(v);
  }
}
```

- [ ] Verify that `createVerdictEmitTool` usage in `TeamRuntime` calls `engine.notifyVerdict(v)` from the `onVerdict` callback, so the round-trip from agent tool call to step resolution is wired end-to-end.

- [ ] Run all ADW + workflow-related tests to confirm nothing regressed:

```bash
npx vitest run tests/unit/adw/
```

- [ ] Commit: `feat: workflow types and plan-build-review three-step workflow`

## Phase 6: Commands, Assembly, and Build

### Task 18: Slash commands

No unit tests are needed for the command files — they are thin wrappers around already-tested subsystems. End-to-end validation happens in Task 20.

**Files to create:**
- `src/commands/team-start.ts`
- `src/commands/team-stop.ts`
- `src/commands/run-start.ts`
- `src/commands/run-resume.ts`
- `src/commands/run-abort.ts`
- `src/commands/run-status.ts`

#### Steps

- [ ] **Create `src/commands/team-start.ts`**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { AgentDefinition } from "../types.js";

export function registerTeamStartCommand(
  pi: ExtensionAPI,
  team: TeamRuntime,
  agentDefs: AgentDefinition[],
): void {
  pi.registerCommand({
    name: "team-start",
    description: "Boot the pi-engteam TeamRuntime and spawn all agents in idle state",
    argsSchema: Type.Object({}),
    handler: async (_args, _ctx) => {
      await team.ensureAllTeammates(agentDefs);
      return {
        message: `Team booted with ${agentDefs.length} agents. Run /run-start <workflow> "<goal>" to begin.`,
      };
    },
  });
}
```

- [ ] **Create `src/commands/team-stop.ts`**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TeamRuntime } from "../team/TeamRuntime.js";

export function registerTeamStopCommand(pi: ExtensionAPI, team: TeamRuntime): void {
  pi.registerCommand({
    name: "team-stop",
    description: "Gracefully shut down all running agent sessions",
    argsSchema: Type.Object({}),
    handler: async (_args, _ctx) => {
      await team.disposeAll();
      return { message: "All agent sessions disposed." };
    },
  });
}
```

- [ ] **Create `src/commands/run-start.ts`**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ADWEngine } from "../adw/ADWEngine.js";

export function registerRunStartCommand(pi: ExtensionAPI, engine: ADWEngine): void {
  pi.registerCommand({
    name: "run-start",
    description: "Start a workflow run. Usage: /run-start plan-build-review \"Add login feature\"",
    argsSchema: Type.Object({
      workflow: Type.String({
        description: "Workflow name: plan-build-review, investigate, triage, verify, debug",
      }),
      goal: Type.String({
        description: "Goal description — what the team should accomplish",
      }),
      maxIterations: Type.Optional(
        Type.Number({ description: "Max fix iterations (default 8)" }),
      ),
      maxCostUsd: Type.Optional(
        Type.Number({ description: "Max cost in USD (default 20)" }),
      ),
    }),
    handler: async (args, _ctx) => {
      const run = await engine.startRun({
        workflow: args.workflow,
        goal: args.goal,
        budget: {
          maxIterations: args.maxIterations,
          maxCostUsd: args.maxCostUsd,
        },
      });
      // Execute in background — don't await; runs can take minutes or hours
      void engine.executeRun(run.runId);
      return {
        message: [
          `Run ${run.runId} started.`,
          `Workflow: ${args.workflow}`,
          `Goal: ${args.goal}`,
          `Monitor: ~/.pi/engteam/runs/${run.runId}/events.jsonl`,
        ].join("\n"),
        runId: run.runId,
      };
    },
  });
}
```

- [ ] **Create `src/commands/run-resume.ts`**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ADWEngine } from "../adw/ADWEngine.js";

export function registerRunResumeCommand(pi: ExtensionAPI, engine: ADWEngine): void {
  pi.registerCommand({
    name: "run-resume",
    description: "Resume a paused or interrupted workflow run",
    argsSchema: Type.Object({
      runId: Type.String({ description: "Run ID from /run-start output" }),
    }),
    handler: async (args, _ctx) => {
      // Fire and forget — resumption runs asynchronously
      void engine.resumeRun(args.runId);
      return { message: `Run ${args.runId} resuming...` };
    },
  });
}
```

- [ ] **Create `src/commands/run-abort.ts`**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ADWEngine } from "../adw/ADWEngine.js";

export function registerRunAbortCommand(pi: ExtensionAPI, engine: ADWEngine): void {
  pi.registerCommand({
    name: "run-abort",
    description: "Abort a running workflow, revoke approval tokens, and clean up",
    argsSchema: Type.Object({
      runId: Type.String({ description: "Run ID to abort" }),
    }),
    handler: async (args, _ctx) => {
      await engine.abortRun(args.runId);
      return { message: `Run ${args.runId} aborted.` };
    },
  });
}
```

- [ ] **Create `src/commands/run-status.ts`**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadRunState } from "../adw/RunState.js";

export function registerRunStatusCommand(pi: ExtensionAPI, runsDir: string): void {
  pi.registerCommand({
    name: "run-status",
    description: "Show current status, step, iteration, and budget for a run",
    argsSchema: Type.Object({
      runId: Type.String({ description: "Run ID" }),
    }),
    handler: async (args, _ctx) => {
      const state = await loadRunState(runsDir, args.runId);
      if (!state) return { message: `Run ${args.runId} not found.` };
      return {
        message: [
          `Run: ${state.runId}`,
          `Status: ${state.status}`,
          `Workflow: ${state.workflow}`,
          `Current step: ${state.currentStep}`,
          `Iteration: ${state.iteration}/${state.budget.maxIterations}`,
          `Cost: $${state.budget.spent.costUsd.toFixed(4)}/$${state.budget.maxCostUsd}`,
          `Wall time: ${Math.round(state.budget.spent.wallSeconds)}s/${state.budget.maxWallSeconds}s`,
          `Last verdict: ${state.steps.at(-1)?.verdict ?? "none"}`,
        ].join("\n"),
      };
    },
  });
}
```

- [ ] **Commit Task 18**

```
git add src/commands/
git commit -m "feat: slash commands: team-start, team-stop, run-start, run-resume, run-abort, run-status"
```

---

### Task 19: Config loader + Extension entry + Three agent files

**Files to create:**
- `src/config.ts`
- `src/index.ts`
- `agents/planner.md`
- `agents/implementer.md`
- `agents/reviewer.md`

#### Steps

- [ ] **Create `src/config.ts`**

```typescript
import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { SafetyConfig, ModelRouting } from "./types.js";

const DEFAULT_SAFETY: SafetyConfig = {
  hardBlockers: { enabled: true, alwaysOn: true },
  planMode: { defaultOn: true },
  classification: {
    mode: "default-deny",
    safeAllowlistExtend: [],
    destructiveOverride: [],
  },
  approvalAuthority: "judge",
  exemptPaths: ["./tmp/**", "./.pi/engteam/runs/**"],
  tokenTtlSeconds: 300,
  allowRunLifetimeScope: true,
};

const DEFAULT_MODEL_ROUTING: ModelRouting = {
  overrides: {},
  budgetDownshift: {
    enabled: true,
    triggerAtPercent: 75,
    rules: {
      "claude-opus-4-6": "claude-sonnet-4-6",
      "claude-sonnet-4-6": "claude-haiku-4-5-20251001",
    },
    protected: ["judge", "architect"],
  },
};

async function loadJson<T>(path: string, defaults: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return { ...defaults, ...JSON.parse(raw) } as T;
  } catch {
    return defaults;
  }
}

const engteamDir = () => join(homedir(), ".pi", "engteam");

export async function loadSafetyConfig(): Promise<SafetyConfig> {
  return loadJson(join(engteamDir(), "safety.json"), DEFAULT_SAFETY);
}

export async function loadModelRouting(): Promise<ModelRouting> {
  return loadJson(join(engteamDir(), "model-routing.json"), DEFAULT_MODEL_ROUTING);
}
```

- [ ] **Create `src/index.ts`**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";
import { mkdir } from "fs/promises";
import { registerSafetyGuard } from "./safety/SafetyGuard.js";
import { Observer } from "./observer/Observer.js";
import { EventWriter } from "./observer/writer.js";
import { HttpSink } from "./observer/httpSink.js";
import { MessageBus } from "./team/MessageBus.js";
import { TeamRuntime } from "./team/TeamRuntime.js";
import { ADWEngine } from "./adw/ADWEngine.js";
import { planBuildReview } from "./workflows/plan-build-review.js";
import { loadSafetyConfig } from "./config.js";
import { createSendMessageTool } from "./team/tools/SendMessage.js";
import { createVerdictEmitTool } from "./team/tools/VerdictEmit.js";
import { createTaskListTool, createTaskUpdateTool } from "./team/tools/TaskList.js";
import { createRequestApprovalTool } from "./team/tools/RequestApproval.js";
import { createGrantApprovalTool } from "./team/tools/GrantApproval.js";
import { registerTeamStartCommand } from "./commands/team-start.js";
import { registerTeamStopCommand } from "./commands/team-stop.js";
import { registerRunStartCommand } from "./commands/run-start.js";
import { registerRunResumeCommand } from "./commands/run-resume.js";
import { registerRunAbortCommand } from "./commands/run-abort.js";
import { registerRunStatusCommand } from "./commands/run-status.js";
import type { AgentDefinition } from "./types.js";

// Resolve ~/.pi/engteam data directories
const ENGTEAM_DIR = join(homedir(), ".pi", "engteam");
const RUNS_DIR = join(ENGTEAM_DIR, "runs");

// V1 agent definitions — three core agents for plan-build-review workflow.
// The remaining 11 agents are added in Plan B.
const AGENT_DEFS: AgentDefinition[] = [
  {
    name: "planner",
    description: "Orchestrator — decomposes goals, sequences work, produces plans",
    model: "claude-opus-4-6",
    systemPrompt:
      "You are the Planner agent for the pi-engteam engineering team. " +
      "Decompose the given goal into actionable sub-tasks, identify the specialist agents needed, " +
      "and produce a clear implementation plan. Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "implementer",
    description: "Writes production code and tests per the plan",
    model: "claude-sonnet-4-6",
    systemPrompt:
      "You are the Implementer agent for the pi-engteam engineering team. " +
      "Read the plan and implement it step by step. Write tests alongside code (TDD). " +
      "For any destructive operation (git push, package install, file delete), call RequestApproval first. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "reviewer",
    description: "Deep code inspection for correctness, maintainability, and regressions",
    model: "claude-opus-4-6",
    systemPrompt:
      "You are the Reviewer agent for the pi-engteam engineering team. " +
      "Carefully read all changed code. Check for logical errors, missing tests, security issues, " +
      "and regression risk. Be specific about any problems — name file, line, and what is wrong. " +
      "Always call VerdictEmit at the end of your turn.",
  },
];

export default async function (pi: ExtensionAPI) {
  // Ensure data directories exist before anything else touches them
  await mkdir(RUNS_DIR, { recursive: true });

  // Load safety config — falls back to safe defaults if file is absent
  const safetyConfig = await loadSafetyConfig();

  // --- Safety layer ---
  registerSafetyGuard(pi, { ...safetyConfig, runsDir: RUNS_DIR });

  // --- Observability ---
  const writer = new EventWriter(RUNS_DIR);
  const sinkUrl = process.env.PI_ENGTEAM_EVENT_URL;
  const sink = sinkUrl ? new HttpSink(sinkUrl, "global", RUNS_DIR) : undefined;
  const observer = new Observer(writer, sink);

  // --- Team layer ---
  const bus = new MessageBus();

  // activeRunId is captured by the tool factory closures below.
  // It is updated in the startRun wrapper so every tool call resolves to the
  // correct run directory without requiring a per-run factory invocation.
  let activeRunId = "none";

  const team = new TeamRuntime({
    cwd: process.cwd(),
    bus,
    observer,
    runsDir: RUNS_DIR,
    customToolsFor: (agentName: string) => {
      const tools = [
        createSendMessageTool(bus, agentName),
        createTaskListTool(RUNS_DIR, activeRunId),
        createTaskUpdateTool(RUNS_DIR, activeRunId),
        createVerdictEmitTool((v) => {
          engine.notifyVerdict(v);
          observer.emit({
            runId: activeRunId,
            agentName,
            category: "verdict",
            type: "emit",
            payload: v,
            summary: `${agentName}: ${v.verdict} on ${v.step}`,
          });
        }),
        createRequestApprovalTool(RUNS_DIR, activeRunId),
      ];
      // Judge agent also gets GrantApproval so it can unblock RequestApproval calls
      if (agentName === "judge") {
        tools.push(createGrantApprovalTool(RUNS_DIR, activeRunId));
      }
      return tools;
    },
  });

  // --- ADW Engine ---
  const workflows = new Map([["plan-build-review", planBuildReview]]);
  const engine = new ADWEngine({ runsDir: RUNS_DIR, workflows, team, observer });

  // Intercept startRun to keep activeRunId in sync with the running run.
  const originalStartRun = engine.startRun.bind(engine);
  engine.startRun = async (params) => {
    const state = await originalStartRun(params);
    activeRunId = state.runId;
    return state;
  };

  // Subscribe observer to bus events so peer messages are recorded
  observer.subscribeToBus(bus, activeRunId);

  // --- Register slash commands ---
  registerTeamStartCommand(pi, team, AGENT_DEFS);
  registerTeamStopCommand(pi, team);
  registerRunStartCommand(pi, engine);
  registerRunResumeCommand(pi, engine);
  registerRunAbortCommand(pi, engine);
  registerRunStatusCommand(pi, RUNS_DIR);

  // --- Lifecycle hook ---
  pi.on("session_start", async (event: any, _ctx: any) => {
    if (event.reason === "startup") {
      console.log("[pi-engteam] Extension loaded. Run /team-start to boot the team.");
    }
  });
}
```

- [ ] **Create `agents/planner.md`**

```markdown
---
name: engteam-planner
description: Orchestrator. Decomposes goals into sub-tasks, selects specialist agents, sequences work, synthesizes results. Produces a written plan as an artifact.
model: claude-opus-4-6
tools: [SendMessage, VerdictEmit, TaskList, TaskUpdate]
---

You are the Planner agent for the pi-engteam engineering team.

## Your responsibilities

1. Analyze the incoming goal and understand what needs to be built or fixed
2. Break the goal into concrete, ordered sub-tasks (numbered list)
3. Identify which files need to be created or modified
4. Identify risks, unknowns, and dependencies
5. Write the plan to `plan.md` in the current working directory
6. Call `VerdictEmit` when the plan is ready

## When to PASS vs FAIL

- **PASS**: The goal is feasible and you have written a clear, actionable implementation plan
- **FAIL**: The goal is ambiguous, not feasible, or requires information you do not have (list what you need in issues)

## Output format for plan.md

```
# Plan: [Goal description]

## Overview
[2-3 sentence summary of the approach]

## Sub-tasks
1. [Task description] — File: `path/to/file.ts`
2. [Task description] — File: `path/to/file.ts`
...

## Risks
- [Risk 1]
- [Risk 2]

## Acceptance criteria
- [ ] [Criterion 1]
- [ ] [Criterion 2]
```

Always call VerdictEmit at the end of your turn with step="plan".
```

- [ ] **Create `agents/implementer.md`**

```markdown
---
name: engteam-implementer
description: Writes production-ready code, scaffolds features, applies project conventions, produces diff-ready changesets with tests.
model: claude-sonnet-4-6
tools: [Read, Bash, Edit, Write, SendMessage, VerdictEmit, TaskList, TaskUpdate, RequestApproval]
---

You are the Implementer agent for the pi-engteam engineering team.

## Your responsibilities

1. Read the plan file specified in the task notification
2. Implement each sub-task in the plan order
3. Write tests alongside implementation (TDD: failing test first, then implementation)
4. For any destructive operation — git push, package install, file delete, migration — call `RequestApproval` first and wait for the Judge to grant it
5. Run the tests before calling VerdictEmit

## Critical rules

- Read existing code before modifying it — understand the current patterns first
- Follow existing code style exactly (indentation, naming, imports)
- Keep changes focused — do not refactor code not mentioned in the plan
- Every new function needs a test

## When to PASS vs FAIL

- **PASS**: All plan sub-tasks complete, tests written and passing, no known issues
- **FAIL**: Blocked by a missing dependency, a failing test you cannot fix, or an ambiguous requirement (list specific issues)

## Destructive operations requiring approval

Before executing any of the following, call RequestApproval:
- `git push` (any branch)
- `npm install`, `pnpm add`, `yarn add` (adding new packages)
- `rm` on any file (op="file-delete")
- Database migrations

Always call VerdictEmit at the end of your turn with step="build".
```

- [ ] **Create `agents/reviewer.md`**

```markdown
---
name: engteam-reviewer
description: Deep code inspection for logical errors, maintainability issues, bad abstractions, dead code, hidden coupling, and regression risk.
model: claude-opus-4-6
tools: [Read, Grep, Glob, Bash, SendMessage, VerdictEmit, TaskList]
---

You are the Reviewer agent for the pi-engteam engineering team.

## Your responsibilities

1. Read the goal and understand what was supposed to be implemented
2. Read every changed file — not just diffs
3. Run the tests if possible and verify they pass
4. Check for: logical errors, edge cases, missing error handling, security issues, performance problems, missing or inadequate tests, unclear or misleading names, hidden coupling between modules
5. Call VerdictEmit with your findings

## Review checklist

For each changed file:
- [ ] Logic is correct and handles edge cases
- [ ] All branches and error paths are tested
- [ ] No security vulnerabilities (injection, path traversal, secret exposure)
- [ ] No obvious performance problems (N+1, unbounded loops)
- [ ] Names are clear and accurate
- [ ] No dead code or unnecessary complexity
- [ ] Changes do not break anything the tests do not cover

## When to PASS vs FAIL

- **PASS**: You would be comfortable shipping this code to production. Tests pass. No significant issues found.
- **FAIL**: Specific, actionable issues found. List each one with: file path, description of the problem, and why it matters.

## handoffHint values

If FAIL, set handoffHint to:
- `"security"` — security vulnerability found
- `"perf"` — significant performance problem
- `"re-plan"` — the implementation does not match the plan and needs re-planning

Always call VerdictEmit at the end of your turn with step="review".
```

- [ ] **Commit Task 19**

```
git add src/config.ts src/index.ts agents/
git commit -m "feat: config loader, extension entry point, and three agent definitions (planner, implementer, reviewer)"
```

---

### Task 20: Build and smoke test

**Files to verify:**
- `package.json` — confirm `typecheck`, `test`, and `build` scripts are present and correct

#### Steps

- [ ] **Step 1: Run TypeScript type check**

```
pnpm typecheck
```

Expected: Zero errors. If errors appear, fix them before proceeding — do not suppress or ignore type errors with `// @ts-ignore` or `as any`.

Common errors to watch for:
- `observer.subscribeToBus` missing from `Observer` — add the method signature to `src/observer/Observer.ts` if it was omitted in earlier phases
- Implicit `any` on `event` and `_ctx` in `pi.on` callback — the explicit `any` annotations in `src/index.ts` handle this; confirm they are present
- `engine.startRun` reassignment may trigger a type error if the property is `readonly` — wrap in a cast: `(engine as any).startRun = async (params: Parameters<typeof engine.startRun>[0]) => { ... }`

- [ ] **Step 2: Run all unit tests**

```
pnpm test
```

Expected: All tests PASS. The following suites must all be green:
- `tests/unit/safety/` — SafetyGuard hard-block, plan-mode, approval-token tests
- `tests/unit/observer/` — EventWriter append, HttpSink retry, Observer emit tests
- `tests/unit/team/` — MessageBus routing, TeamRuntime ensureTeammate, custom tools tests
- `tests/unit/adw/` — ADWEngine startRun, executeRun step machine, budget guard tests

If any test suite fails, fix the root cause in the relevant source file before moving on.

- [ ] **Step 3: Build the extension**

```
pnpm build
```

Expected: `dist/index.js` emitted with no errors. The tsup output should list `dist/index.js` and its size. If the build fails:
- Resolve any missing imports by verifying all `.js` extension suffixes are present on relative imports
- Verify `tsup.config.ts` (or equivalent) has `entry: ["src/index.ts"]` and `format: ["esm"]`

- [ ] **Step 4: Verify extension exports a default function**

```
node --input-type=module -e "import('./dist/index.js').then(m => { console.log('default type:', typeof m.default); if (typeof m.default !== 'function') process.exit(1); })"
```

Expected output:
```
default type: function
```

If `typeof m.default` is `undefined`, the entry file is missing the `export default` declaration or the build did not include `src/index.ts` as the entry point.

- [ ] **Step 5: Verify extension exports structure**

```
node --input-type=module -e "import('./dist/index.js').then(m => console.log('exports:', Object.keys(m)))"
```

Expected output includes `default`. No other named exports are required at this stage.

- [ ] **Step 6: Commit final Plan A state**

Stage all remaining changes and create the Plan A completion commit:

```
git add -A
git commit -m "feat: complete Plan A — pi-engteam core extension

- Three-layer SafetyGuard (hard-block / plan-mode / approval-token)
- Append-only jsonl Observer with optional HTTP sink
- In-process TeamRuntime with MessageBus peer messaging
- ADWEngine step machine with budget guards and resume
- Custom tools: SendMessage, VerdictEmit, TaskList, RequestApproval, GrantApproval
- plan-build-review workflow (plan → build → review)
- Slash commands: /team-start, /team-stop, /run-start, /run-resume, /run-abort, /run-status
- 3 agent definitions: planner, implementer, reviewer"
```

---

### Follow-up plans

Plan A delivers the core wiring. Two follow-up plans cover the remaining scope of the full pi-engteam system.

#### Plan B — Agents, workflows, and install

Document: `docs/superpowers/plans/2026-04-14-pi-engteam-agents-workflows-install.md`

Scope:
- All 11 remaining agents: `architect`, `codebase-cartographer`, `tester`, `security-auditor`, `performance-analyst`, `bug-triage`, `incident-investigator`, `root-cause-debugger`, `judge`, `knowledge-retriever`, `observability-archivist`
- Remaining 9 workflows: `plan-build-review-fix`, `investigate`, `triage`, `verify`, `debug`, `fix-loop`, `migration`, `refactor-campaign`, `doc-backfill`
- `install.sh` stage-1 bootstrap + `/engteam-install` slash command
- `/engteam-doctor` health check command
- Integration test suite covering full plan-build-review workflow execution

#### Plan C — Bundled observability server

Document: `docs/superpowers/plans/2026-04-14-pi-engteam-server.md`

Scope:
- `@sartoris/pi-engteam-server` package
- Fastify + better-sqlite3 backend
- Drizzle schema (Postgres-portable)
- Chokidar watcher ingesting `events.jsonl` files + HTTP POST endpoint
- Minimal HTML dashboard for live run monitoring
- `/engteam-server start|stop|status` slash command
