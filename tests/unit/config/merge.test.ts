import { describe, it, expect } from "vitest";
import { deepMerge, mergeLayers, type ConfigLayer } from "../../../src/config/merge.js";

const layer = (name: ConfigLayer["name"], value: ConfigLayer["value"]): ConfigLayer => ({ name, value, path: null });

describe("deepMerge", () => {
  it("later values win for scalars and objects merge key by key", () => {
    expect(deepMerge({ a: 1, b: { x: 1, y: 2 } }, { a: 2, b: { y: 3, z: 4 } })).toEqual({
      a: 2,
      b: { x: 1, y: 3, z: 4 },
    });
  });

  it("arrays replace instead of concatenating", () => {
    expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
  });

  it("null deletes the key", () => {
    expect(deepMerge({ a: 1, b: { x: 1 } }, { a: null, b: { x: null } })).toEqual({ b: {} });
    expect(deepMerge({}, { a: null })).toEqual({});
  });

  it("an object overlay replaces a scalar or array base value", () => {
    expect(deepMerge({ a: 1, l: [1] }, { a: { k: 1 }, l: { m: 2 } })).toEqual({ a: { k: 1 }, l: { m: 2 } });
  });

  it("never mutates or aliases its inputs", () => {
    const base = { list: [1], obj: { k: "v" } };
    const overlay = { list: [2], obj: { k2: "v2" } };
    const out = deepMerge(base, overlay);
    expect(base).toEqual({ list: [1], obj: { k: "v" } });
    expect(overlay).toEqual({ list: [2], obj: { k2: "v2" } });
    expect(out.list).not.toBe(overlay.list);
    (out.obj as Record<string, unknown>)["k3"] = "x";
    expect(base.obj).toEqual({ k: "v" });
    expect(overlay.obj).toEqual({ k2: "v2" });
  });

  it("does not alias nested base objects the overlay never visits", () => {
    const base = { nested: { value: 1 } };
    const result = deepMerge(base, {});
    (result.nested as { value: number }).value = 2;
    expect(base.nested.value).toBe(1);
    expect(result.nested).not.toBe(base.nested);
  });
});

describe("mergeLayers", () => {
  it("applies layers in order and records the winning layer per leaf", () => {
    const { config, provenance } = mergeLayers([
      layer("builtin", {
        maxDiffLines: 400,
        steering: "always",
        branching: { nameTemplate: "factory/{id}", draftPolicy: "elevated" },
        checks: [],
      }),
      layer("global", { maxDiffLines: 300, branching: { nameTemplate: "f/{id}" } }),
      layer("committed", { branching: { base: "develop" }, checks: [{ name: "unit" }] }),
      layer("overrides", { maxDiffLines: 250 }),
      layer("local", { steering: "elevated" }),
    ]);
    expect(config).toEqual({
      maxDiffLines: 250,
      steering: "elevated",
      branching: { nameTemplate: "f/{id}", draftPolicy: "elevated", base: "develop" },
      checks: [{ name: "unit" }],
    });
    expect(provenance).toEqual({
      maxDiffLines: "overrides",
      steering: "local",
      "branching.nameTemplate": "global",
      "branching.draftPolicy": "builtin",
      "branching.base": "committed",
      checks: "committed",
    });
  });

  it("drops provenance for keys a later layer deletes, including whole subtrees", () => {
    const { config, provenance } = mergeLayers([
      layer("builtin", { laneEnv: { basePort: 3000, template: ".env" }, setupCommand: ["pnpm", "i"] }),
      layer("local", { laneEnv: { basePort: null }, setupCommand: null }),
    ]);
    expect(config).toEqual({ laneEnv: { template: ".env" } });
    expect(provenance).toEqual({ "laneEnv.template": "builtin" });

    const replaced = mergeLayers([layer("builtin", { a: { x: 1 } }), layer("local", { a: [1] })]);
    expect(replaced.config).toEqual({ a: [1] });
    expect(replaced.provenance).toEqual({ a: "local" });
  });

  it("calls beforeApply with the config as it stands before that layer", () => {
    const seen: string[] = [];
    mergeLayers([layer("builtin", { steering: "always" }), layer("local", { steering: "elevated" })], {
      beforeApply: (l, current) => {
        seen.push(`${l.name}:${JSON.stringify(current)}`);
      },
    });
    expect(seen).toEqual(["builtin:{}", 'local:{"steering":"always"}']);
  });

  it("returns an empty config for no layers", () => {
    expect(mergeLayers([])).toEqual({ config: {}, provenance: {} });
  });
});
