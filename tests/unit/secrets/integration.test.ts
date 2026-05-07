// tests/unit/secrets/integration.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  processInput,
  registerWatcher,
  type IntegrationConfig,
  type PromptDecision,
  type PromptFn,
} from "../../../src/secrets/Integration.js";
import { DEFAULT_PATTERNS, type SecretPattern } from "../../../src/secrets/patterns.js";
import type { Vault } from "../../../src/secrets/Vault.js";
import type { SecretMatch } from "../../../src/secrets/Watcher.js";

const A20 = "A".repeat(20);
const A36 = "A".repeat(36);

type EmittedEvent = {
  category: "safety";
  type: "secret_skip" | "secret_access";
  payload: Record<string, unknown>;
};

function makeVaultStub() {
  const calls: Array<{ name: string; value: string; notes?: string }> = [];
  const stub = {
    set: vi.fn((name: string, value: string, notes?: string) => {
      calls.push({ name, value, notes });
    }),
  };
  return { stub: stub as unknown as Vault, calls, set: stub.set };
}

function makeConfig(overrides: Partial<IntegrationConfig> = {}): {
  config: IntegrationConfig;
  vaultCalls: Array<{ name: string; value: string; notes?: string }>;
  events: EmittedEvent[];
  vaultSet: ReturnType<typeof vi.fn>;
} {
  const { stub: vault, calls: vaultCalls, set: vaultSet } = makeVaultStub();
  const events: EmittedEvent[] = [];
  const config: IntegrationConfig = {
    enabled: true,
    interactivePrompt: true,
    onSkipBehavior: "warn",
    entropyEnabled: false,
    vault,
    emitEvent: (e) => {
      events.push(e);
    },
    loadPatterns: () => DEFAULT_PATTERNS,
    ...overrides,
  };
  return { config, vaultCalls, events, vaultSet };
}

function promptFromQueue(queue: PromptDecision[]): PromptFn {
  return async () => {
    const next = queue.shift();
    if (!next) throw new Error("prompt queue empty");
    return next;
  };
}

describe("processInput — pass-through with no matches", () => {
  it("returns pass-through and rewritten === input", async () => {
    const { config } = makeConfig();
    const input = "hello world, no secrets here";
    const result = await processInput(input, config, async () => {
      throw new Error("prompt should not be called");
    });
    expect(result.action).toBe("pass-through");
    if (result.action === "pass-through") {
      expect(result.rewritten).toBe(input);
    }
  });
});

describe("processInput — single match vaulted", () => {
  it("returns vault-and-rewrite with placeholder and calls vault.set", async () => {
    const { config, vaultCalls, vaultSet } = makeConfig();
    const value = `sk-ant-${A20}`;
    const input = `my key is ${value}, ok?`;
    const result = await processInput(
      input,
      config,
      promptFromQueue([{ choice: "vault", vaultName: "ANTHROPIC_API_KEY" }]),
    );
    expect(result.action).toBe("vault-and-rewrite");
    if (result.action === "vault-and-rewrite") {
      expect(result.rewritten).toBe("my key is ${SECRET:ANTHROPIC_API_KEY}, ok?");
      expect(result.vaulted).toEqual([{ name: "ANTHROPIC_API_KEY", original: value }]);
    }
    expect(vaultSet).toHaveBeenCalledTimes(1);
    expect(vaultCalls[0]).toEqual({
      name: "ANTHROPIC_API_KEY",
      value,
      notes: "auto-vaulted via watcher",
    });
  });
});

describe("processInput — single match skipped", () => {
  it("returns pass-through with input unchanged and emits secret_skip", async () => {
    const { config, events, vaultSet } = makeConfig();
    const value = `sk-ant-${A20}`;
    const input = `key=${value}`;
    const result = await processInput(input, config, promptFromQueue([{ choice: "skip" }]));
    expect(result.action).toBe("pass-through");
    if (result.action === "pass-through") {
      expect(result.rewritten).toBe(input);
    }
    expect(vaultSet).not.toHaveBeenCalled();
    expect(events.length).toBe(1);
    expect(events[0].category).toBe("safety");
    expect(events[0].type).toBe("secret_skip");
    expect(events[0].payload.suggestedName).toBe("ANTHROPIC_API_KEY");
    expect(events[0].payload.preview).toBe(`${value.slice(0, 6)}...${value.slice(-4)}`);
    // Original value MUST NOT be in payload.
    for (const v of Object.values(events[0].payload)) {
      expect(v).not.toBe(value);
    }
  });
});

describe("processInput — single match aborted", () => {
  it("returns user-aborted immediately", async () => {
    const { config, vaultSet, events } = makeConfig();
    const value = `sk-ant-${A20}`;
    const input = `key=${value}`;
    const result = await processInput(input, config, promptFromQueue([{ choice: "abort" }]));
    expect(result.action).toBe("user-aborted");
    expect(vaultSet).not.toHaveBeenCalled();
    expect(events.length).toBe(0);
  });
});

describe("processInput — two matches both vaulted", () => {
  it("replaces both with their placeholders", async () => {
    const { config, vaultCalls, vaultSet } = makeConfig();
    const v1 = `sk-ant-${A20}`;
    const v2 = `ghp_${A36}`;
    const input = `a=${v1} b=${v2}`;
    const result = await processInput(
      input,
      config,
      promptFromQueue([
        { choice: "vault", vaultName: "ANTHROPIC_API_KEY" },
        { choice: "vault", vaultName: "GITHUB_TOKEN" },
      ]),
    );
    expect(result.action).toBe("vault-and-rewrite");
    if (result.action === "vault-and-rewrite") {
      expect(result.rewritten).toBe(
        "a=${SECRET:ANTHROPIC_API_KEY} b=${SECRET:GITHUB_TOKEN}",
      );
      expect(result.vaulted.map((p) => p.name)).toEqual(["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]);
    }
    expect(vaultSet).toHaveBeenCalledTimes(2);
    expect(vaultCalls[0]).toEqual({
      name: "ANTHROPIC_API_KEY",
      value: v1,
      notes: "auto-vaulted via watcher",
    });
    expect(vaultCalls[1]).toEqual({
      name: "GITHUB_TOKEN",
      value: v2,
      notes: "auto-vaulted via watcher",
    });
  });
});

describe("processInput — first vault, second skip", () => {
  it("replaces first, leaves second in place, emits one skip", async () => {
    const { config, events, vaultCalls, vaultSet } = makeConfig();
    const v1 = `sk-ant-${A20}`;
    const v2 = `ghp_${A36}`;
    const input = `a=${v1} b=${v2}`;
    const result = await processInput(
      input,
      config,
      promptFromQueue([
        { choice: "vault", vaultName: "ANTHROPIC_API_KEY" },
        { choice: "skip" },
      ]),
    );
    expect(result.action).toBe("vault-and-rewrite");
    if (result.action === "vault-and-rewrite") {
      // First replaced with placeholder; second left as the raw token.
      expect(result.rewritten).toBe(`a=\${SECRET:ANTHROPIC_API_KEY} b=${v2}`);
      expect(result.vaulted).toEqual([{ name: "ANTHROPIC_API_KEY", original: v1 }]);
    }
    expect(vaultSet).toHaveBeenCalledTimes(1);
    expect(vaultCalls[0].name).toBe("ANTHROPIC_API_KEY");
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("secret_skip");
    expect(events[0].payload.suggestedName).toBe("GITHUB_TOKEN");
  });
});

describe("processInput — vault overwrite when name conflicts", () => {
  it("overwrites existing vault entry without erroring (user owns the name)", async () => {
    // Vault stub records every set; we just ensure a duplicate name doesn't throw.
    const { config, vaultCalls, vaultSet } = makeConfig();
    const v1 = `sk-ant-${A20}`;
    const v2 = `sk-ant-${"B".repeat(20)}`;
    const input = `a=${v1} b=${v2}`;
    const result = await processInput(
      input,
      config,
      promptFromQueue([
        { choice: "vault", vaultName: "MY_KEY" },
        { choice: "vault", vaultName: "MY_KEY" },
      ]),
    );
    expect(result.action).toBe("vault-and-rewrite");
    expect(vaultSet).toHaveBeenCalledTimes(2);
    expect(vaultCalls[0].name).toBe("MY_KEY");
    expect(vaultCalls[1].name).toBe("MY_KEY");
  });
});

describe("registerWatcher", () => {
  it("registers an input handler on the pi extension API", () => {
    const onSpy = vi.fn();
    const pi = { on: onSpy } as unknown as Parameters<typeof registerWatcher>[0];
    const { config } = makeConfig();
    registerWatcher(pi, config);
    expect(onSpy).toHaveBeenCalledTimes(1);
    expect(onSpy.mock.calls[0][0]).toBe("input");
    expect(typeof onSpy.mock.calls[0][1]).toBe("function");
  });

  it("returns continue when config.enabled is false", async () => {
    const onSpy = vi.fn();
    const pi = { on: onSpy } as unknown as Parameters<typeof registerWatcher>[0];
    const { config } = makeConfig({ enabled: false });
    registerWatcher(pi, config);
    const handler = onSpy.mock.calls[0][1] as (
      event: { text: string; images?: unknown },
      ctx: { ui: { notify: (m: string, t?: string) => void } },
    ) => Promise<{ action: string }>;
    const result = await handler(
      { text: `key=sk-ant-${A20}` },
      { ui: { notify: vi.fn() } },
    );
    expect(result.action).toBe("continue");
  });

  it("when enabled and silent, transforms input by auto-vaulting", async () => {
    const onSpy = vi.fn();
    const pi = { on: onSpy } as unknown as Parameters<typeof registerWatcher>[0];
    const { config, vaultSet } = makeConfig({ interactivePrompt: false });
    registerWatcher(pi, config);
    const handler = onSpy.mock.calls[0][1] as (
      event: { text: string; images?: unknown },
      ctx: { ui: { notify: (m: string, t?: string) => void } },
    ) => Promise<{ action: string; text?: string }>;
    const value = `sk-ant-${A20}`;
    const result = await handler(
      { text: `key=${value}` },
      { ui: { notify: vi.fn() } },
    );
    expect(result.action).toBe("transform");
    expect(result.text).toBe("key=${SECRET:ANTHROPIC_API_KEY}");
    expect(vaultSet).toHaveBeenCalledTimes(1);
  });
});

describe("processInput — uses injected loadPatterns", () => {
  it("respects custom pattern set", async () => {
    const custom: SecretPattern[] = [
      { name: "Custom", regex: /MYSECRET-[0-9]+/g, suggestedName: "CUSTOM_KEY", priority: 0 },
    ];
    const { config, vaultSet } = makeConfig({ loadPatterns: () => custom });
    const input = "before MYSECRET-12345 after";
    const result = await processInput(
      input,
      config,
      promptFromQueue([{ choice: "vault", vaultName: "CUSTOM_KEY" }]),
    );
    expect(result.action).toBe("vault-and-rewrite");
    if (result.action === "vault-and-rewrite") {
      expect(result.rewritten).toBe("before ${SECRET:CUSTOM_KEY} after");
    }
    expect(vaultSet).toHaveBeenCalledTimes(1);
  });
});

// Sanity check: confirm SecretMatch shape passed to prompt is what we expect.
describe("processInput — prompt receives full SecretMatch", () => {
  it("prompt callback gets pattern, preview, and offsets", async () => {
    const { config } = makeConfig();
    const value = `sk-ant-${A20}`;
    const input = `k=${value}`;
    let received: SecretMatch | undefined;
    await processInput(input, config, async (m) => {
      received = m;
      return { choice: "abort" };
    });
    expect(received).toBeDefined();
    expect(received!.pattern.name).toBe("Anthropic API key");
    expect(received!.pattern.suggestedName).toBe("ANTHROPIC_API_KEY");
    expect(received!.value).toBe(value);
    expect(received!.preview).toBe(`${value.slice(0, 6)}...${value.slice(-4)}`);
  });
});
