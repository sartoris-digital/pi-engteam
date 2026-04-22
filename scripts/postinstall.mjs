#!/usr/bin/env node
/**
 * postinstall.mjs — runs after `npm install` / `pi install`.
 *
 * 1. Builds the observability server bundle (server.cjs) via tsup.
 * 2. Installs server.cjs + native better_sqlite3.node → ~/.pi/engteam/
 * 3. Installs agent markdown files → ~/.pi/agent/agents/engteam-*.md
 *
 * Idempotent. Never exits with a non-zero code — postinstall failure must not
 * block `npm install` or `pi install`.
 */

import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const HOME = homedir();
const PI_DIR = join(HOME, ".pi");
const ENGTEAM_DIR = join(PI_DIR, "engteam");
const AGENTS_DIR = join(PI_DIR, "agent", "agents");

/** Resolve the actual tsup CLI JS entry (avoids running the shell shim via node). */
async function findTsupCli() {
  const tsupPkgPath = join(ROOT, "node_modules", "tsup", "package.json");
  if (!existsSync(tsupPkgPath)) return null;
  try {
    const pkg = JSON.parse(await readFile(tsupPkgPath, "utf8"));
    const bin = pkg.bin?.tsup ?? pkg.bin;
    if (typeof bin === "string") return join(ROOT, "node_modules", "tsup", bin);
  } catch { /* fall through */ }
  return null;
}

/** Build server/index.ts → dist/server.cjs via tsup. */
async function buildServer() {
  const tsupCli = await findTsupCli();
  if (!tsupCli) {
    console.warn("[pi-engteam] postinstall: tsup not found — skipping server build");
    return false;
  }

  const result = spawnSync(
    process.execPath,
    [
      tsupCli,
      "--entry.server", "server/index.ts",
      "--format", "cjs",
      "--external", "better-sqlite3",
      "--no-splitting",
      "--no-config",
      "--out-dir", "dist",
    ],
    { cwd: ROOT, stdio: "inherit" },
  );

  if (result.status !== 0) {
    console.warn(`[pi-engteam] postinstall: server build failed (exit ${result.status})`);
    return false;
  }
  return true;
}

/** Copy server.cjs + native addon → ~/.pi/engteam/. */
async function installServer() {
  const serverBundle = join(ROOT, "dist", "server.cjs");
  if (!existsSync(serverBundle)) {
    console.warn("[pi-engteam] postinstall: dist/server.cjs not found — skipping");
    return;
  }

  await mkdir(ENGTEAM_DIR, { recursive: true });
  await copyFile(serverBundle, join(ENGTEAM_DIR, "server.cjs"));
  console.log(`[pi-engteam] installed server      → ${join(ENGTEAM_DIR, "server.cjs")}`);

  // Copy only the compiled .node binary so server.cjs can load it via the
  // nativeBinding option — no full node_modules tree needed next to server.cjs.
  const nativeSrc = join(
    ROOT,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  if (existsSync(nativeSrc)) {
    await copyFile(nativeSrc, join(ENGTEAM_DIR, "better_sqlite3.node"));
    console.log(`[pi-engteam] installed native addon → ${join(ENGTEAM_DIR, "better_sqlite3.node")}`);
  } else {
    console.warn("[pi-engteam] postinstall: better_sqlite3.node not found — /observe will fail");
  }
}

/** Copy agents/*.md → ~/.pi/agent/agents/engteam-*.md. */
async function installAgents() {
  // Skip silently when Pi is not installed (e.g., CI environments).
  if (!existsSync(PI_DIR)) {
    console.log("[pi-engteam] postinstall: ~/.pi not found — skipping agent install");
    return;
  }

  await mkdir(AGENTS_DIR, { recursive: true });

  const srcDir = join(ROOT, "agents");
  let files;
  try {
    files = (await readdir(srcDir)).filter((f) => f.endsWith(".md"));
  } catch {
    console.warn("[pi-engteam] postinstall: agents/ directory not found — skipping");
    return;
  }

  await Promise.all(
    files.map((f) => copyFile(join(srcDir, f), join(AGENTS_DIR, `engteam-${f}`))),
  );
  console.log(`[pi-engteam] installed ${files.length} agent(s) → ${AGENTS_DIR}`);
}

async function main() {
  console.log("[pi-engteam] postinstall: building server and installing files...");
  await buildServer(); // best-effort; skipped if tsup (devDep) is unavailable
  await installServer(); // always attempt — uses pre-built dist/server.cjs if build was skipped
  await installAgents();
  console.log("[pi-engteam] postinstall done.");
}

main().catch((err) => {
  // Non-fatal — log but never block `npm install` / `pi install`
  console.error("[pi-engteam] postinstall error:", err?.message ?? String(err));
});
