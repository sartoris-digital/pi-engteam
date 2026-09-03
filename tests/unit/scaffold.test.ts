import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { withTmpHome } from "../helpers/tmp-home.js";

describe("scaffold", () => {
  it("package.json declares the pi extension entry and v1 vault runtime deps", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      name: string;
      type: string;
      pi: unknown;
      engines: { node: string };
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe("@sartoris/pi-sdlc-factory");
    expect(pkg.type).toBe("module");
    expect(pkg.engines.node).toBe(">=22");
    expect(pkg.pi).toEqual({ extensions: ["./src/index.ts"] });
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@napi-rs/keyring",
      "better-sqlite3",
      "typebox",
      "yaml",
    ]);
  });

  it("locks the 0.84 peer range, NodeNext toolchain and no-bundler contract", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      packageManager: string;
      scripts: Record<string, string>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      dependencies: Record<string, string>;
    };
    const ts = JSON.parse(await readFile(new URL("../../tsconfig.json", import.meta.url), "utf8")) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("^0.84.4");
    expect(pkg.devDependencies["@earendil-works/pi-coding-agent"]).toBe("^0.84.4");
    expect(pkg.packageManager.startsWith("pnpm@")).toBe(true);
    expect(pkg.scripts).toEqual({
      test: "vitest run",
      "test:watch": "vitest",
      typecheck: "tsc --noEmit -p tsconfig.json",
    });
    expect(ts.compilerOptions.module).toBe("NodeNext");
    expect(ts.compilerOptions.moduleResolution).toBe("NodeNext");
    expect(ts.compilerOptions.target).toBe("ES2022");
    expect(ts.compilerOptions.strict).toBe(true);
    expect(ts.compilerOptions.noUncheckedIndexedAccess).toBe(true);
    for (const bundler of ["esbuild", "tsup", "webpack", "rollup", "vite", "parcel"]) {
      expect(pkg.dependencies[bundler], bundler).toBeUndefined();
      expect(pkg.devDependencies[bundler], bundler).toBeUndefined();
    }
  });

  it("src/index.ts default export registers /factory in controller mode", async () => {
    const mod = await import("../../src/index.js");
    expect(typeof mod.default).toBe("function");
    const touched: string[] = [];
    const pi = new Proxy(
      {},
      {
        get(_target, prop) {
          touched.push(String(prop));
          return () => undefined;
        },
      },
    );
    await withTmpHome(async () => {
      await mod.default(pi as never);
    });
    expect(touched).toEqual(["registerCommand", "on", "on", "on"]);
  });
});
