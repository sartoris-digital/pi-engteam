import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createSetFit, type CliTransport } from "../../../src/v3/setfit.js";
import { StubEncoder } from "../../helpers/stub-setfit.js";

describe("SetFit stub encoder", () => {
  it("maps 'crash in login' to bug with score 0.9", async () => {
    const stub = new StubEncoder();
    const pred = await stub.infer("crash in login");
    expect(pred).toEqual({ kind: "bug", score: 0.9 });
  });

  it("createSetFit({ encoder: stub }) does not spawn a process", async () => {
    const uv: CliTransport = {
      exec: async () => {
        throw new Error("uv must not run when encoder is injected");
      },
    };
    const stub = new StubEncoder();
    const enc = createSetFit({ encoder: stub, uv });
    await expect(enc.infer("crash in login")).resolves.toEqual({ kind: "bug", score: 0.9 });
    await expect(enc.train([{ text: "crash in login", kind: "bug" }])).resolves.toEqual({
      modelDir: stub.modelDir,
    });
    expect(stub.inferCalls).toEqual(["crash in login"]);
    expect(stub.trainCalls).toHaveLength(1);
  });
});

describe("SetFit production uv wrapper", () => {
  it("records uv argv containing --offline and never loads transformers", async () => {
    const calls: { argv: string[]; input?: string }[] = [];
    const uv: CliTransport = {
      async exec(argv, opts) {
        calls.push({ argv: [...argv], input: opts?.input });
        return { code: 0, stdout: JSON.stringify({ kind: "bug", score: 0.9, modelDir: "/tmp/m" }), stderr: "" };
      },
    };
    const enc = createSetFit({ uv, modelDir: "/tmp/m" });
    const pred = await enc.infer("crash in login");
    expect(pred).toEqual({ kind: "bug", score: 0.9 });
    expect(calls).toHaveLength(1);
    const argv = calls[0]!.argv;
    expect(argv[0]).toBe("uv");
    expect(argv).toContain("--offline");
    expect(argv).toContain("--script");
    expect(argv.some((a) => a.endsWith("setfit-run.py"))).toBe(true);

    await enc.train([{ text: "crash in login", kind: "bug" }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.argv).toContain("--offline");
    expect(calls[1]!.argv).toContain("train");
  });

  it("production wrapper and stub helper do not import model libraries", async () => {
    const files = [
      fileURLToPath(new URL("../../../src/v3/setfit.ts", import.meta.url)),
      fileURLToPath(new URL("../../../src/v3/setfit-run.py", import.meta.url)),
      fileURLToPath(new URL("../../helpers/stub-setfit.ts", import.meta.url)),
    ];
    const banned = ["transformers", "torch", "huggingface"];
    for (const path of files) {
      const text = (await readFile(path, "utf8")).toLowerCase();
      for (const word of banned) expect(text.includes(word)).toBe(false);
    }
  });
});
