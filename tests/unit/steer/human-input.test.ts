import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatedMarker as homeGeneratedMarker } from "../../../src/home.js";
import {
  generatedMarker,
  humanInputPath,
  normalizeHumanInput,
  runIdFromRunDir,
  writeHumanInput,
} from "../../../src/steer/human-input.js";

let tmp: string;
let runDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "sdlc-human-input-"));
  runDir = join(tmp, "runs", "run-0001");
  await mkdir(runDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("writeHumanInput", () => {
  it("writes <runDir>/human-input/steer-<n>.md with the marker first and the notes fenced under the run nonce", async () => {
    const path = await writeHumanInput(runDir, 2, "Keep the badge row.\r\nDo not touch docs/.", "n0nce-test");
    expect(path).toBe(join(runDir, "human-input", "steer-2.md"));
    expect(path).toBe(humanInputPath(runDir, 2));

    const text = await readFile(path, "utf8");
    expect(text.split("\n")[0]).toBe("<!-- pi-sdlc-factory generated · run run-0001 · do not commit -->");
    expect(text).toContain("# Steering notes 2");
    expect(text).toContain("Keep the badge row.\nDo not touch docs/.");
    expect(text).toContain("n0nce-test");
    // the fence opener (carrying the nonce) precedes the operator text
    expect(text.indexOf("Keep the badge row.")).toBeGreaterThan(text.indexOf("n0nce-test"));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("refuses empty input and non-positive indexes", async () => {
    await expect(writeHumanInput(runDir, 1, "  \u200B \n", "n0nce-test")).rejects.toThrow(/empty/);
    await expect(writeHumanInput(runDir, 0, "notes", "n0nce-test")).rejects.toThrow(RangeError);
    await expect(writeHumanInput(runDir, 1.5, "notes", "n0nce-test")).rejects.toThrow(RangeError);
  });
});

describe("normalizeHumanInput", () => {
  it("strips zero-width characters and C0 controls but keeps newlines and tabs", () => {
    expect(normalizeHumanInput("a\u200Bb\u0007c\tD\r\nE\uFEFF")).toBe("abc\tD\nE");
    expect(normalizeHumanInput("\n  plain  \n")).toBe("plain");
  });
});

describe("marker helpers", () => {
  it("derives the run id from the run dir basename and re-exports the one marker from home.ts", () => {
    expect(runIdFromRunDir("/x/runs/run-42")).toBe("run-42");
    expect(generatedMarker).toBe(homeGeneratedMarker);
    expect(generatedMarker("run-42")).toBe("<!-- pi-sdlc-factory generated · run run-42 · do not commit -->");
  });
});
