#!/usr/bin/env node
import { buildServer } from "./server.js";
import { join } from "path";
import { homedir } from "os";

const PORT = parseInt(process.env.PI_ENGTEAM_SERVER_PORT ?? "4747", 10);
const DATA_DIR = process.env.PI_ENGTEAM_DATA_DIR ?? join(homedir(), ".pi", "engteam");
const DB_PATH = join(DATA_DIR, "server", "engteam.sqlite");
const RUNS_DIR = join(DATA_DIR, "runs");

async function main() {
  const app = buildServer({ dbPath: DB_PATH, runsDir: RUNS_DIR, port: PORT });
  await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`[pi-engteam-server] Listening on http://127.0.0.1:${PORT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
