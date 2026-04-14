#!/usr/bin/env node
import { buildServer } from "./server.js";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

const PORT = parseInt(process.env.PI_ENGTEAM_SERVER_PORT ?? "4747", 10);
const DATA_DIR = process.env.PI_ENGTEAM_DATA_DIR ?? join(homedir(), ".pi", "engteam");
const DB_PATH = join(DATA_DIR, "server", "engteam.sqlite");
const RUNS_DIR = join(DATA_DIR, "runs");

// better-sqlite3 uses the `bindings` package to locate its native addon, but
// `bindings` is not resolvable when spawned from the install directory.
// Pass the absolute path directly so Database() skips the bindings lookup.
const NATIVE_BINDING_CANDIDATES = [
  // Placed next to server.cjs by install.sh
  join(__dirname, "better_sqlite3.node"),
  // Fallback: standard build path inside copied node_modules
  join(__dirname, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
];
const NATIVE_BINDING = NATIVE_BINDING_CANDIDATES.find(existsSync);

async function main() {
  const app = buildServer({ dbPath: DB_PATH, runsDir: RUNS_DIR, port: PORT, nativeBinding: NATIVE_BINDING });
  await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`[pi-engteam-server] Listening on http://127.0.0.1:${PORT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
