#!/usr/bin/env node
/**
 * Wire the repository's versioned Git hooks into the local checkout.
 *
 * This is intentionally a native Git hooksPath setup instead of a package
 * dependency. Outside a Git worktree (for example, package extraction during
 * install) it no-ops so postinstall/prepare remain portable.
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_PATH = ".githooks";
const PRE_COMMIT = join(ROOT, HOOKS_PATH, "pre-commit");

const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
  cwd: ROOT,
  encoding: "utf8",
});

if (inside.status !== 0 || inside.stdout.trim() !== "true") {
  process.exit(0);
}

const topLevel = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: ROOT,
  encoding: "utf8",
});

if (topLevel.status !== 0 || realpathSync(topLevel.stdout.trim()) !== realpathSync(ROOT)) {
  process.exit(0);
}

if (!existsSync(PRE_COMMIT)) {
  console.error("[pi-engineering] missing .githooks/pre-commit");
  process.exit(1);
}

const config = spawnSync("git", ["config", "core.hooksPath", HOOKS_PATH], {
  cwd: ROOT,
  stdio: "inherit",
});

if (config.error) {
  console.error(`[pi-engineering] failed to configure Git hooks: ${config.error.message}`);
  process.exit(1);
}

process.exit(config.status ?? 1);
