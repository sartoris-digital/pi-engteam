import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const LINT_PY = join(ROOT, "src/codify/py/codify_lint.py");
const GOLDEN = join(ROOT, "tests/fixtures/codify/bump-version.tool.py");

function python3Available(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function lint(path: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("python3", [LINT_PY, path], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("codify_lint.py", () => {
  it.skipIf(!python3Available())("passes the golden bump-version tool", async () => {
    const r = await lint(GOLDEN);
    expect(r.stdout.trim(), r.stderr).toBe("");
    expect(r.code).toBe(0);
  });

  it.skipIf(!python3Available())("fails a tool that imports subprocess", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codify-lint-"));
    try {
      const dirty = join(dir, "tool.py");
      await writeFile(
        dirty,
        [
          "# /// script",
          "# requires-python = \">=3.11\"",
          "# dependencies = []",
          "# ///",
          "import subprocess",
          "def main() -> None:",
          "    subprocess.run(['true'])",
          "main()",
          "",
        ].join("\n"),
        "utf8",
      );
      const r = await lint(dirty);
      expect(r.code).not.toBe(0);
      expect(`${r.stdout}\n${r.stderr}`).toMatch(/subprocess/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
