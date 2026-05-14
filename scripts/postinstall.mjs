#!/usr/bin/env node
/**
 * postinstall.mjs — runs after `npm install` / `pi install`.
 *
 * 1. Builds the observability server bundle (server.cjs) via tsup.
 * 2. Installs server.cjs + native better_sqlite3.node → ~/.pi/engineering-team/
 * 3. Installs agent markdown files → ~/.pi/agent/agents/engineering-*.md
 *
 * Idempotent. Never exits with a non-zero code — postinstall failure must not
 * block `npm install` or `pi install`.
 */

import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const HOME = homedir();
const PI_DIR = join(HOME, ".pi");
const ENGINEERING_DIR = join(PI_DIR, "engineering-team");
const EXTENSION_DIR = join(PI_DIR, "agent", "extensions");
const AGENTS_DIR = join(PI_DIR, "agent", "agents");
const VERIFIER_SCRIPTS_DIR = join(ENGINEERING_DIR, "verifier-scripts");

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
    console.warn("[pi-engineering] postinstall: tsup not found — skipping server build");
    return false;
  }

  // better-sqlite3's JS wrapper MUST be bundled (the install dir has no
  // node_modules); the compiled .node binary is sideloaded by server/index.ts
  // via the `nativeBinding` option, so the bundled `require('bindings')` path
  // is never executed at runtime.
  const result = spawnSync(
    process.execPath,
    [
      tsupCli,
      "--entry.server", "server/index.ts",
      "--format", "cjs",
      "--no-splitting",
      "--no-config",
      "--out-dir", "dist",
    ],
    { cwd: ROOT, stdio: "inherit" },
  );

  if (result.status !== 0) {
    console.warn(`[pi-engineering] postinstall: server build failed (exit ${result.status})`);
    return false;
  }
  return true;
}

/** Copy server.cjs + native addon → ~/.pi/engineering-team/. */
async function installServer() {
  const serverBundle = join(ROOT, "dist", "server.cjs");
  if (!existsSync(serverBundle)) {
    console.warn("[pi-engineering] postinstall: dist/server.cjs not found — skipping");
    return;
  }

  await mkdir(ENGINEERING_DIR, { recursive: true });
  await copyFile(serverBundle, join(ENGINEERING_DIR, "server.cjs"));
  console.log(`[pi-engineering] installed server      → ${join(ENGINEERING_DIR, "server.cjs")}`);

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
    await copyFile(nativeSrc, join(ENGINEERING_DIR, "better_sqlite3.node"));
    console.log(`[pi-engineering] installed native addon → ${join(ENGINEERING_DIR, "better_sqlite3.node")}`);
    // The extension bundle (Vault) needs the same binary at ~/.pi/agent/extensions
    // so its `nativeBinding` resolver in src/secrets/Vault.ts finds it.
    if (existsSync(EXTENSION_DIR)) {
      await copyFile(nativeSrc, join(EXTENSION_DIR, "better_sqlite3.node"));
      console.log(`[pi-engineering] installed native addon → ${join(EXTENSION_DIR, "better_sqlite3.node")}`);
    }
  } else {
    console.warn("[pi-engineering] postinstall: better_sqlite3.node not found — /observe and /secret-* will fail");
  }
}

/** Walk `node_modules/@napi-rs` and `node_modules/.pnpm` for the host's compiled
 *  keyring binary and copy it next to the extension bundle. pnpm installs only
 *  the matching platform optionalDependency, so a single `.node` is present. */
async function installKeyringNative() {
  if (!existsSync(EXTENSION_DIR)) return; // ~/.pi/agent/extensions not present yet

  async function findKeyringNode(dir, depth) {
    if (depth > 5) return null;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return null; }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = await findKeyringNode(child, depth + 1);
        if (hit) return hit;
      } else if (/^keyring\..+\.node$/.test(entry.name)) {
        return child;
      }
    }
    return null;
  }

  const searchRoots = [
    join(ROOT, "node_modules", "@napi-rs"),
    join(ROOT, "node_modules", ".pnpm"),
  ];
  for (const root of searchRoots) {
    const hit = await findKeyringNode(root, 0);
    if (hit) {
      const dest = join(EXTENSION_DIR, basename(hit));
      await copyFile(hit, dest);
      console.log(`[pi-engineering] installed keyring native → ${dest}`);
      return;
    }
  }
  console.warn("[pi-engineering] postinstall: @napi-rs/keyring native .node not found — /secret-* will silently degrade in bundled-install mode");
}

/** Copy agents/*.md → ~/.pi/agent/agents/engineering-*.md. */
async function installAgents() {
  // Skip silently when Pi is not installed (e.g., CI environments).
  if (!existsSync(PI_DIR)) {
    console.log("[pi-engineering] postinstall: ~/.pi not found — skipping agent install");
    return;
  }

  await mkdir(AGENTS_DIR, { recursive: true });

  const srcDir = join(ROOT, "agents");
  let files;
  try {
    files = (await readdir(srcDir)).filter((f) => f.endsWith(".md"));
  } catch {
    console.warn("[pi-engineering] postinstall: agents/ directory not found — skipping");
    return;
  }

  await Promise.all(
    files.map((f) => copyFile(join(srcDir, f), join(AGENTS_DIR, `engineering-${f}`))),
  );
  console.log(`[pi-engineering] installed ${files.length} agent(s) → ${AGENTS_DIR}`);
}

/** Copy src/assets/verifier-scripts/*.py → ~/.pi/engineering-team/verifier-scripts/. */
async function installVerifierScripts() {
  const srcDir = join(ROOT, "src", "assets", "verifier-scripts");
  let files;
  try {
    files = (await readdir(srcDir)).filter((f) => f.endsWith(".py"));
  } catch {
    console.warn("[pi-engineering] postinstall: src/assets/verifier-scripts not found — skipping");
    return;
  }
  await mkdir(VERIFIER_SCRIPTS_DIR, { recursive: true });
  await Promise.all(
    files.map((f) => copyFile(join(srcDir, f), join(VERIFIER_SCRIPTS_DIR, f))),
  );
  console.log(`[pi-engineering] installed ${files.length} verifier script(s) → ${VERIFIER_SCRIPTS_DIR}`);
}

/** Phase 3.5: ensure Learner staging/versions/fixtures + CHANGELOG exist. */
async function installLearnerScaffold() {
  const stagingDir = join(VERIFIER_SCRIPTS_DIR, ".staging");
  const versionsDir = join(VERIFIER_SCRIPTS_DIR, ".versions");
  const fixturesDir = join(VERIFIER_SCRIPTS_DIR, ".fixtures");
  const changelogPath = join(VERIFIER_SCRIPTS_DIR, "CHANGELOG.md");

  await mkdir(stagingDir, { recursive: true });
  await mkdir(versionsDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });

  if (!existsSync(changelogPath)) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      changelogPath,
      "# Verifier-script CHANGELOG\n\nEvery promotion from .staging/ to active is logged here by the Learner orchestrator.\n",
    );
    console.log(`[pi-engineering] created CHANGELOG → ${changelogPath}`);
  }
  console.log(`[pi-engineering] learner scaffold ready → ${VERIFIER_SCRIPTS_DIR}/.staging,.versions,.fixtures`);
}

async function main() {
  console.log("[pi-engineering] postinstall: building server and installing files...");
  await buildServer(); // best-effort; skipped if tsup (devDep) is unavailable
  await installServer(); // always attempt — uses pre-built dist/server.cjs if build was skipped
  await installKeyringNative();
  await installAgents();
  await installVerifierScripts();
  await installLearnerScaffold();
  console.log("[pi-engineering] postinstall done.");
}

main().catch((err) => {
  // Non-fatal — log but never block `npm install` / `pi install`
  console.error("[pi-engineering] postinstall error:", err?.message ?? String(err));
});
