import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATED_MARKER, GENERATED_DOC_PATTERNS, generatedMarkerLine, findGeneratedDocs } from "../../../src/gate/generated-docs.js";
import { generatedMarker } from "../../../src/home.js";
import type { Workspace } from "../../../src/workspace/types.js";

let dir = "";
let ws: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gate-gendocs-"));
  ws = { provider: "git", path: dir, branch: "main", baseSha: "", repoRoot: dir, gitCommonDir: join(dir, ".git"), configSha: "" };
  await mkdir(join(dir, "docs"), { recursive: true });
  await mkdir(join(dir, "notes"), { recursive: true });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "docs/PLAN.md"), "# plan\n", "utf8");
  await writeFile(join(dir, "notes/thing.ai.md"), "ai notes\n", "utf8");
  await writeFile(join(dir, "README.md"), `${generatedMarkerLine("run-42")}\n# readme\n`, "utf8");
  await writeFile(join(dir, "src/ok.ts"), "export const ok = 1;\n", "utf8");
  await writeFile(join(dir, "src/late-marker.ts"), `// first line\n${generatedMarkerLine("run-42")}\n`, "utf8");
  await writeFile(join(dir, "docs/guide.md"), "# guide\n", "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("marker", () => {
  it("renders the contract marker line and is the home.ts definition", () => {
    expect(generatedMarkerLine("run-42")).toBe("<!-- pi-sdlc-factory generated · run run-42 · do not commit -->");
    expect(generatedMarkerLine("run-42").startsWith(GENERATED_MARKER)).toBe(true);
    expect(generatedMarkerLine).toBe(generatedMarker); // re-export, not a second literal
  });

  it("ships the spec default pattern list", () => {
    expect(GENERATED_DOC_PATTERNS).toEqual([
      "**/PLAN.md", "**/*.plan.md", "**/spec.md", "**/design.md", "**/diagnosis.md", "**/steer-packet.md",
      "**/issue-brief.md", "**/analysis.md", "**/review.md", "**/verdict.md", "docs/superpowers/**", ".omc/**",
      ".pi/*.local.*", ".pi/factory-rules*.yaml", "**/*.ai.md",
    ]);
  });
});

describe("findGeneratedDocs", () => {
  it("flags files by pattern and by first-line marker only", async () => {
    const changed = ["docs/PLAN.md", "notes/thing.ai.md", "README.md", "src/ok.ts", "src/late-marker.ts", "docs/guide.md"];
    const found = await findGeneratedDocs(ws, changed);
    expect(found).toEqual(["README.md", "docs/PLAN.md", "notes/thing.ai.md"]);
  });

  it("flags a pattern match even when the file no longer exists (deleted in the diff)", async () => {
    expect(await findGeneratedDocs(ws, [".omc/specs/gone.md", "src/ok.ts"])).toEqual([".omc/specs/gone.md"]);
  });

  it("normalizes absolute and ./ paths and dedupes", async () => {
    const found = await findGeneratedDocs(ws, [join(dir, "README.md"), "./README.md", "README.md"]);
    expect(found).toEqual(["README.md"]);
  });

  it("uses custom patterns when given", async () => {
    const found = await findGeneratedDocs(ws, ["docs/guide.md", "src/ok.ts"], ["docs/**"]);
    expect(found).toEqual(["docs/guide.md"]);
  });

  it("returns an empty list for a clean diff", async () => {
    expect(await findGeneratedDocs(ws, ["src/ok.ts", "src/late-marker.ts"])).toEqual([]);
    expect(await findGeneratedDocs(ws, [])).toEqual([]);
  });
});
