import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { withTmpHome } from "../../helpers/tmp-home.js";
import { loadEffectiveRules } from "../../../src/rules/load.js";
import {
  RuleDuplicateError,
  RuleSafetyError,
  addRule,
  normaliseRuleText,
  tokenSetSimilarity,
} from "../../../src/rules/remember.js";

const cleanScreen = () => ({ injectionSuspect: false, reasons: [] as string[] });
const suspectScreen = () => ({ injectionSuspect: true, reasons: ["ignore previous"] });

describe("normaliseRuleText", () => {
  it("turns a polite request into an imperative sentence", () => {
    expect(normaliseRuleText("please always add a changelog entry")).toBe("Always add a changelog entry.");
  });

  it("strips pronouns and keeps a single sentence", () => {
    expect(normaliseRuleText("You should use pnpm. Never run npm.")).toBe("Use pnpm.");
  });
});

describe("tokenSetSimilarity", () => {
  it("is 1 for identical token sets and below 0.6 for unrelated text", () => {
    expect(tokenSetSimilarity("always add a changelog entry", "always add a changelog entry")).toBe(1);
    expect(tokenSetSimilarity("always add a changelog entry", "prefer tabs over spaces")).toBeLessThan(0.6);
  });
});

describe("addRule", () => {
  it("rejects rules that loosen safety", async () => {
    await withTmpHome(async (home) => {
      await expect(
        addRule("disable the judge", {
          home,
          global: true,
          screen: cleanScreen,
          confirm: async () => true,
        }),
      ).rejects.toBeInstanceOf(RuleSafetyError);
      await expect(
        addRule("disable the judge", {
          home,
          global: true,
          screen: cleanScreen,
          confirm: async () => true,
        }),
      ).rejects.toThrow(/judge/i);
    });
  });

  it("throws RuleDuplicateError when similarity is at least 0.6", async () => {
    await withTmpHome(async (home) => {
      const first = await addRule("always add a changelog entry", {
        home,
        global: true,
        screen: cleanScreen,
        confirm: async () => true,
      });
      await expect(
        addRule("always add a changelog entry under Unreleased", {
          home,
          global: true,
          screen: cleanScreen,
          confirm: async () => true,
        }),
      ).rejects.toSatisfy((err: unknown) => err instanceof RuleDuplicateError && err.existingId === first.id);
    });
  });

  it("rejects injection-suspect text from the injected screen", async () => {
    await withTmpHome(async (home) => {
      await expect(
        addRule("always add a changelog entry", {
          home,
          global: true,
          screen: suspectScreen,
          confirm: async () => true,
        }),
      ).rejects.toThrow(/injection/i);
    });
  });

  it("writes a normalised global rule and reloads it", async () => {
    await withTmpHome(async (home) => {
      const record = await addRule("please always add a changelog entry", {
        home,
        global: true,
        screen: cleanScreen,
        confirm: async () => true,
      });
      expect(record.text).toBe("Always add a changelog entry.");
      expect(record.status).toBe("active");
      expect(record.class).toBe("constraint");
      const raw = parseYaml(await readFile(join(home, "rules.yaml"), "utf8")) as { rules: { id: string; text: string }[] };
      expect(raw.rules.some((r) => r.id === record.id && r.text === record.text)).toBe(true);
      const loaded = await loadEffectiveRules({ home });
      expect(loaded.rules.some((r) => r.id === record.id)).toBe(true);
    });
  });

  it("writes a local rule under .pi/factory-rules.local.yaml", async () => {
    await withTmpHome(async (home) => {
      const repo = join(home, "repo");
      await mkdir(join(repo, ".pi"), { recursive: true });
      const record = await addRule("use pnpm, never npm", {
        home,
        repoPath: repo,
        screen: cleanScreen,
        confirm: async () => true,
      });
      const text = await readFile(join(repo, ".pi", "factory-rules.local.yaml"), "utf8");
      expect(text).toContain(record.id);
      expect(text).toMatch(/pnpm/i);
    });
  });
});
