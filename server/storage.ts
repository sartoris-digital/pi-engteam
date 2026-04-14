import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  current_step TEXT,
  iteration INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  step TEXT,
  agent_name TEXT,
  summary TEXT,
  payload TEXT NOT NULL,
  UNIQUE(run_id, ts, type, category),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
`;

export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function upsertRun(db: Db, run: {
  runId: string; workflow: string; goal: string; status: string;
  currentStep?: string; iteration?: number; createdAt: string; updatedAt: string;
}): void {
  db.prepare(`
    INSERT INTO runs (run_id, workflow, goal, status, current_step, iteration, created_at, updated_at)
    VALUES (@runId, @workflow, @goal, @status, @currentStep, @iteration, @createdAt, @updatedAt)
    ON CONFLICT(run_id) DO UPDATE SET
      workflow=excluded.workflow, goal=excluded.goal,
      status=excluded.status, current_step=excluded.current_step,
      iteration=excluded.iteration, updated_at=excluded.updated_at
  `).run({ runId: run.runId, workflow: run.workflow, goal: run.goal, status: run.status,
           currentStep: run.currentStep ?? null, iteration: run.iteration ?? 0,
           createdAt: run.createdAt, updatedAt: run.updatedAt });
}

/** Insert a minimal run stub only if the run_id doesn't already exist.
 *  Used by EventWatcher to satisfy the FK constraint before inserting events. */
export function ensureRunExists(db: Db, runId: string, ts: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO runs (run_id, workflow, goal, status, created_at, updated_at)
    VALUES (?, 'unknown', '', 'running', ?, ?)
  `).run(runId, ts, ts);
}

export function insertEvent(db: Db, event: {
  runId: string; ts: string; category: string; type: string;
  step?: string; agentName?: string; summary?: string; payload: Record<string, unknown>;
}): void {
  db.prepare(`
    INSERT OR IGNORE INTO events (run_id, ts, category, type, step, agent_name, summary, payload)
    VALUES (@runId, @ts, @category, @type, @step, @agentName, @summary, @payload)
  `).run({ runId: event.runId, ts: event.ts, category: event.category, type: event.type,
           step: event.step ?? null, agentName: event.agentName ?? null,
           summary: event.summary ?? null, payload: JSON.stringify(event.payload) });
}

export function listRuns(db: Db, limit = 50, offset = 0): unknown[] {
  return db.prepare(`SELECT run_id, workflow, goal, status, current_step, iteration, created_at, updated_at FROM runs ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
}

export function getRun(db: Db, runId: string): unknown {
  return db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId);
}

export function getEvents(db: Db, runId: string, opts: { limit?: number; offset?: number; category?: string; since?: string } = {}): unknown[] {
  const conditions = ["run_id = ?"];
  const params: unknown[] = [runId];
  if (opts.category) { conditions.push("category = ?"); params.push(opts.category); }
  if (opts.since) { conditions.push("ts >= ?"); params.push(opts.since); }
  params.push(opts.limit ?? 200, opts.offset ?? 0);
  return db.prepare(`SELECT * FROM events WHERE ${conditions.join(" AND ")} ORDER BY ts ASC LIMIT ? OFFSET ?`).all(...params);
}

export function countEvents(db: Db, runId: string): number {
  const row = db.prepare(`SELECT COUNT(*) as n FROM events WHERE run_id = ?`).get(runId) as { n: number };
  return row.n;
}
