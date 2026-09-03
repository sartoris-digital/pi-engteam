import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks, OUTPUT_TAIL_BYTES } from "../../../src/gate/checks.js";
import type { Workspace } from "../../../src/workspace/types.js";

const node = process.execPath;
let dir = "";
let ws: Workspace;

function wsFor(path: string): Workspace {
  return { provider: "git", path, branch: "main", baseSha: "", repoRoot: path, gitCommonDir: join(path, ".git"), configSha: "" };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gate-checks-"));
  ws = wsFor(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function script(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, body, "utf8");
  return p;
}

describe("runChecks", () => {
  it("captures the exit code and the output tail", async () => {
    const s = await script("exit3.mjs", `console.log("hello from check"); process.exitCode = 3;`);
    const [r] = await runChecks(ws, [{ name: "exit3", argv: [node, s], reporter: "none", timeoutSeconds: 30 }], { timeoutMs: 10_000, concurrency: 1 });
    expect(r?.name).toBe("exit3");
    expect(r?.exitCode).toBe(3);
    expect(r?.timedOut).toBe(false);
    expect(r?.outputTail).toContain("hello from check");
    expect(r?.report).toBeNull();
    expect(r?.flaky).toEqual([]);
    expect(r?.reran).toBe(false);
  });

  it("keeps only the last 4 KB of output", async () => {
    const s = await script("big.mjs", `process.stdout.write("x".repeat(10000) + "END");`);
    const [r] = await runChecks(ws, [{ name: "big", argv: [node, s], reporter: "none", timeoutSeconds: 30 }], { timeoutMs: 10_000, concurrency: 1 });
    expect(r?.exitCode).toBe(0);
    expect(r?.outputTail.length).toBe(OUTPUT_TAIL_BYTES);
    expect(r?.outputTail.endsWith("END")).toBe(true);
  });

  it("times out under the smaller of the global and per-check timeouts", async () => {
    const s = await script("hang.mjs", `setTimeout(() => {}, 10_000);`);
    const [r] = await runChecks(ws, [{ name: "hang", argv: [node, s], reporter: "none", timeoutSeconds: 30 }], { timeoutMs: 300, concurrency: 1 });
    expect(r?.timedOut).toBe(true);
    expect(r?.exitCode).toBeNull();
    expect(r?.durationMs).toBeLessThan(5_000);
  });

  it("reports a missing binary as exitCode null with the spawn error in the tail", async () => {
    const [r] = await runChecks(ws, [{ name: "missing", argv: ["definitely-missing-binary-xyz-123"], reporter: "none", timeoutSeconds: 5 }], { timeoutMs: 5_000, concurrency: 1 });
    expect(r?.exitCode).toBeNull();
    expect(r?.timedOut).toBe(false);
    expect(r?.outputTail).toContain("ENOENT");
  });

  it("parses the junit report at junitPath (relative to the workspace)", async () => {
    const s = await script(
      "junit.mjs",
      `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], '<testsuite name="s"><testcase classname="c" name="ok"/><testcase classname="c" name="bad"><failure message="nope"/></testcase></testsuite>');
process.exitCode = 1;`,
    );
    const [r] = await runChecks(
      ws,
      [{ name: "unit", argv: [node, s, join(dir, "report.xml")], reporter: "junit", timeoutSeconds: 30, junitPath: "report.xml" }],
      { timeoutMs: 10_000, concurrency: 1 },
    );
    expect(r?.exitCode).toBe(1);
    expect(r?.report?.counts).toEqual({ total: 2, passed: 1, failed: 1, error: 0, skipped: 0 });
    expect(r?.report?.cases.map((c) => c.id)).toEqual(["c::ok", "c::bad"]);
  });

  it("deletes a stale junit file before running so an old report is never read", async () => {
    await writeFile(join(dir, "report.xml"), '<testsuite name="stale"><testcase classname="c" name="old"/></testsuite>', "utf8");
    const s = await script("noop.mjs", ``);
    const [r] = await runChecks(
      ws,
      [{ name: "unit", argv: [node, s], reporter: "junit", timeoutSeconds: 30, junitPath: "report.xml" }],
      { timeoutMs: 10_000, concurrency: 1 },
    );
    expect(r?.exitCode).toBe(0);
    expect(r?.report).toBeNull();
    expect((await readdir(dir)).includes("report.xml")).toBe(false);
  });

  it("re-runs a failing check once and records ids that flip as flaky", async () => {
    const s = await script(
      "flaky.mjs",
      `import { existsSync, writeFileSync } from "node:fs";
const [stateFile, reportFile] = process.argv.slice(2);
const first = !existsSync(stateFile);
if (first) writeFileSync(stateFile, "ran");
const body = first ? '<failure message="flaked"/>' : "";
writeFileSync(reportFile, '<testsuite name="s"><testcase classname="c" name="wobbly">' + body + '</testcase><testcase classname="c" name="steady"/></testsuite>');
process.exitCode = first ? 1 : 0;`,
    );
    const [r] = await runChecks(
      ws,
      [{ name: "unit", argv: [node, s, join(dir, "state"), join(dir, "report.xml")], reporter: "junit", timeoutSeconds: 30, junitPath: "report.xml" }],
      { timeoutMs: 10_000, concurrency: 1, rerunFailedOnce: true },
    );
    expect(r?.reran).toBe(true);
    expect(r?.flaky).toEqual(["c::wobbly"]);
    expect(r?.exitCode).toBe(0);
    expect(r?.report?.counts.failed).toBe(0);
    expect(await readFile(join(dir, "state"), "utf8")).toBe("ran");
  });

  it("does not re-run when rerunFailedOnce is off", async () => {
    const s = await script(
      "fail.mjs",
      `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], '<testsuite name="s"><testcase classname="c" name="bad"><failure message="x"/></testcase></testsuite>');
process.exitCode = 1;`,
    );
    const [r] = await runChecks(
      ws,
      [{ name: "unit", argv: [node, s, join(dir, "report.xml")], reporter: "junit", timeoutSeconds: 30, junitPath: "report.xml" }],
      { timeoutMs: 10_000, concurrency: 1 },
    );
    expect(r?.reran).toBe(false);
    expect(r?.report?.counts.failed).toBe(1);
  });

  it("honours the concurrency semaphore and preserves input order", async () => {
    const probe = await script(
      "probe.mjs",
      `import { writeFileSync, readdirSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
const mine = join(dir, "run-" + process.pid);
writeFileSync(mine, "");
const running = readdirSync(dir).filter((f) => f.startsWith("run-")).length;
const maxFile = join(dir, "max");
const prev = existsSync(maxFile) ? Number(readFileSync(maxFile, "utf8")) : 0;
if (running > prev) writeFileSync(maxFile, String(running));
setTimeout(() => { unlinkSync(mine); }, 400);`,
    );
    const checks = [
      { name: "one", argv: [node, probe, dir], reporter: "none" as const, timeoutSeconds: 30 },
      { name: "two", argv: [node, probe, dir], reporter: "none" as const, timeoutSeconds: 30 },
    ];
    const serial = await runChecks(ws, checks, { timeoutMs: 10_000, concurrency: 1 });
    expect(serial.map((r) => r.name)).toEqual(["one", "two"]);
    expect(await readFile(join(dir, "max"), "utf8")).toBe("1");

    await rm(join(dir, "max"), { force: true });
    const parallel = await runChecks(ws, checks, { timeoutMs: 10_000, concurrency: 2 });
    expect(parallel.map((r) => r.name)).toEqual(["one", "two"]);
    expect(await readFile(join(dir, "max"), "utf8")).toBe("2");
  });
});
