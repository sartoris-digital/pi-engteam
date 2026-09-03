import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

describe("scaffold", () => {
  it("package.json declares the pi extension entry and only typebox + yaml at runtime", async () => {
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
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["typebox", "yaml"]);
  });

  it("src/index.ts default export is a function that registers nothing yet", async () => {
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
    await mod.default(pi as never);
    expect(touched).toEqual([]);
  });
});
