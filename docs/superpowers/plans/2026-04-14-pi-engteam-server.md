# pi-engteam — Observability Server Implementation Plan

**Date:** 2026-04-14
**Phase:** Plan C — Bundled SQLite observability server
**Covers:** Server scaffold, SQLite storage, REST API, JSONL watcher, HTML dashboard, /observe command

---

# Plan C — Section 1: Bundled SQLite Observability Server

**Project:** `/Users/ndcollins/Clients/Sartoris/Projects/pi-engteam`
**Package:** `@sartoris/pi-engteam-server` (separate bundled process)
**Date:** 2026-04-14

---

## Overview

This section covers building the observability server that ships alongside the Pi engteam extension. The server is a standalone Node.js process that:

1. Exposes a REST API (Fastify) for querying runs and events stored in SQLite
2. Accepts event ingestion via HTTP POST (used by an `HttpSink` in the extension)
3. Is launched via `npx @sartoris/pi-engteam-server` or the `/observe` Pi slash command
4. Reads/writes `~/.pi/engteam/server/engteam.sqlite`

**Tech stack:** Fastify 5, better-sqlite3 (sync bindings), vitest, tsup

**New files introduced:**

```
server/
  index.ts        CLI entry point
  server.ts       Fastify app factory
  storage.ts      SQLite open + schema + query helpers
  routes.ts       REST route registrations
  types.ts        ServerOptions shared type
tests/unit/server/
  server.test.ts
  storage.test.ts
  routes.test.ts
```

**Existing file modified:**

```
tsup.config.ts   Add second entry for server/index.ts
package.json     Add bin, fastify, better-sqlite3 deps
```

---

## Task 1: Server Scaffold

### Files

- `server/types.ts`
- `server/index.ts`
- `server/server.ts`
- `tests/unit/server/server.test.ts`

### `server/types.ts`

```typescript
export type ServerOptions = {
  dbPath: string;
  runsDir: string;
};
```

### `server/index.ts`

```typescript
#!/usr/bin/env node
import { buildServer } from "./server.js";
import { join } from "path";
import { homedir } from "os";

const PORT = parseInt(process.env.PI_ENGTEAM_SERVER_PORT ?? "4747", 10);
const DATA_DIR =
  process.env.PI_ENGTEAM_DATA_DIR ?? join(homedir(), ".pi", "engteam");
const DB_PATH = join(DATA_DIR, "server", "engteam.sqlite");
const RUNS_DIR = join(DATA_DIR, "runs");

async function main() {
  const app = buildServer({ dbPath: DB_PATH, runsDir: RUNS_DIR });
  await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`[pi-engteam-server] Listening on http://127.0.0.1:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**Notes:**
- `#!/usr/bin/env node` shebang is injected by tsup's `banner` option (see Task 4) — do not rely on it being present in source during tests.
- `PI_ENGTEAM_SERVER_PORT` and `PI_ENGTEAM_DATA_DIR` are the two supported env overrides.

### `server/server.ts`

```typescript
import Fastify, { FastifyInstance } from "fastify";
import { openDb } from "./storage.js";
import { registerRoutes } from "./routes.js";
import type { ServerOptions } from "./types.js";

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const db = openDb(opts.dbPath);
  registerRoutes(app, db, opts);
  return app;
}
```

**Notes:**
- `logger: false` keeps test output clean. Production logging can be added later via an option flag.
- `openDb` is called eagerly at build time so schema is guaranteed to exist before any request arrives.
- `registerRoutes` is the single integration point — routes stay in their own file for isolation.

### `tests/unit/server/server.test.ts`

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { buildServer } from "../../../server/server.js";

describe("buildServer", () => {
  let app: ReturnType<typeof buildServer>;

  afterEach(async () => {
    await app.close();
  });

  it("returns a Fastify instance with an inject method", () => {
    app = buildServer({ dbPath: ":memory:", runsDir: "/tmp/runs" });
    expect(typeof app.inject).toBe("function");
  });

  it("GET /health returns { ok: true }", async () => {
    app = buildServer({ dbPath: ":memory:", runsDir: "/tmp/runs" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
```

**Why these tests:**
- The Fastify instance check verifies `buildServer` wires dependencies correctly without requiring a real port.
- The `/health` test is the minimal end-to-end smoke test — if this passes, `openDb`, `registerRoutes`, and `buildServer` are all wired together correctly.
- `afterEach` closes the app to release the in-memory SQLite and avoid handle leaks between tests.

### Steps

1. **Write tests** — create `tests/unit/server/server.test.ts` with the two tests above. Run `pnpm test` and confirm both fail with "Cannot find module '../../../server/server.js'".
2. **Verify fail** — expected errors: module not found for `server/server.ts`, `server/storage.ts`, `server/routes.ts`, `server/types.ts`.
3. **Implement** — create `server/types.ts`, `server/server.ts`. At this stage, `server/storage.ts` and `server/routes.ts` can be stubs:
   - `storage.ts`: export `openDb(_path: string) { return {} as any; }`
   - `routes.ts`: export `registerRoutes(_app, _db, _opts) {}`
4. **Run tests** — `pnpm test tests/unit/server/server.test.ts`. Both tests should pass (the health route stub is not registered yet, so `/health` will 404 until routes are stubbed to include it — stub `registerRoutes` to call `app.get("/health", async () => ({ ok: true }))`).
5. **Commit** — `git commit -m "feat: server scaffold with Fastify app factory"`

---

## Task 2: SQLite Storage Layer

### Files

- `server/storage.ts`
- `tests/unit/server/storage.test.ts`

### `server/storage.ts`

```typescript
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id      TEXT PRIMARY KEY,
  workflow    TEXT NOT NULL,
  goal        TEXT NOT NULL,
  status      TEXT NOT NULL,
  current_step TEXT,
  iteration   INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  ts          TEXT NOT NULL,
  category    TEXT NOT NULL,
  type        TEXT NOT NULL,
  step        TEXT,
  agent_name  TEXT,
  summary     TEXT,
  payload     TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_events_run_id  ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
`;

export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  return db;
}

export function upsertRun(
  db: Db,
  run: {
    runId: string;
    workflow: string;
    goal: string;
    status: string;
    currentStep?: string;
    iteration?: number;
    createdAt: string;
    updatedAt: string;
  }
): void {
  db.prepare(`
    INSERT INTO runs (run_id, workflow, goal, status, current_step, iteration, created_at, updated_at)
    VALUES (@runId, @workflow, @goal, @status, @currentStep, @iteration, @createdAt, @updatedAt)
    ON CONFLICT(run_id) DO UPDATE SET
      status       = excluded.status,
      current_step = excluded.current_step,
      iteration    = excluded.iteration,
      updated_at   = excluded.updated_at
  `).run({
    runId: run.runId,
    workflow: run.workflow,
    goal: run.goal,
    status: run.status,
    currentStep: run.currentStep ?? null,
    iteration: run.iteration ?? 0,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  });
}

export function insertEvent(
  db: Db,
  event: {
    runId: string;
    ts: string;
    category: string;
    type: string;
    step?: string;
    agentName?: string;
    summary?: string;
    payload: Record<string, unknown>;
  }
): void {
  db.prepare(`
    INSERT INTO events (run_id, ts, category, type, step, agent_name, summary, payload)
    VALUES (@runId, @ts, @category, @type, @step, @agentName, @summary, @payload)
  `).run({
    runId: event.runId,
    ts: event.ts,
    category: event.category,
    type: event.type,
    step: event.step ?? null,
    agentName: event.agentName ?? null,
    summary: event.summary ?? null,
    payload: JSON.stringify(event.payload),
  });
}

export function listRuns(db: Db, limit = 50, offset = 0): unknown[] {
  return db
    .prepare(`
      SELECT run_id, workflow, goal, status, current_step, iteration, created_at, updated_at
      FROM runs
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(limit, offset);
}

export function getRun(db: Db, runId: string): unknown {
  return db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId);
}

export function getEvents(
  db: Db,
  runId: string,
  opts: {
    limit?: number;
    offset?: number;
    category?: string;
    since?: string;
  } = {}
): unknown[] {
  const conditions = ["run_id = ?"];
  const params: unknown[] = [runId];

  if (opts.category) {
    conditions.push("category = ?");
    params.push(opts.category);
  }
  if (opts.since) {
    conditions.push("ts >= ?");
    params.push(opts.since);
  }

  params.push(opts.limit ?? 200, opts.offset ?? 0);

  return db
    .prepare(`
      SELECT * FROM events
      WHERE ${conditions.join(" AND ")}
      ORDER BY ts ASC
      LIMIT ? OFFSET ?
    `)
    .all(...(params as Parameters<Database.Statement["all"]>));
}

export function countEvents(db: Db, runId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM events WHERE run_id = ?`)
    .get(runId) as { n: number };
  return row.n;
}
```

**Notes:**
- `mkdirSync` with `recursive: true` is a no-op when `dbPath` is `":memory:"` — `dirname(":memory:")` is `"."` which always exists, so the in-memory path is safe for tests.
- WAL mode and `NORMAL` synchronous are set after schema init. WAL improves concurrent read performance; for a local single-writer server this is a quality-of-life setting.
- `upsertRun` uses `ON CONFLICT ... DO UPDATE` (SQLite upsert syntax). Only mutable fields (`status`, `current_step`, `iteration`, `updated_at`) are updated — `workflow`, `goal`, and `created_at` are write-once.
- `getEvents` builds a dynamic WHERE clause rather than using separate prepared statements. This keeps the query count down and is safe because conditions are only ever literal string constants (no user input injected into the SQL text).
- `payload` is stored as a JSON string. Callers deserialise as needed.

### `tests/unit/server/storage.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import {
  openDb,
  upsertRun,
  insertEvent,
  listRuns,
  getRun,
  getEvents,
  countEvents,
  type Db,
} from "../../../server/storage.js";

// Helper: create a fresh in-memory database for each test.
let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const RUN_A = {
  runId: "run-aaa",
  workflow: "fullstack",
  goal: "Build login page",
  status: "running",
  currentStep: "implement",
  iteration: 2,
  createdAt: "2026-04-14T10:00:00.000Z",
  updatedAt: "2026-04-14T10:05:00.000Z",
};

const RUN_B = {
  runId: "run-bbb",
  workflow: "bugfix",
  goal: "Fix null pointer in auth",
  status: "succeeded",
  currentStep: "done",
  iteration: 1,
  createdAt: "2026-04-14T09:00:00.000Z",
  updatedAt: "2026-04-14T09:30:00.000Z",
};

function makeEvent(overrides: Partial<Parameters<typeof insertEvent>[1]> = {}) {
  return {
    runId: "run-aaa",
    ts: "2026-04-14T10:01:00.000Z",
    category: "lifecycle",
    type: "step.started",
    payload: { step: "implement" },
    ...overrides,
  };
}

// ── openDb ───────────────────────────────────────────────────────────────────

describe("openDb", () => {
  it("creates the runs table", () => {
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='runs'`
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("runs");
  });

  it("creates the events table", () => {
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='events'`
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("events");
  });

  it("creates the three expected indexes on events", () => {
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'`
      )
      .all() as { name: string }[];
    const names = indexes.map((r) => r.name);
    expect(names).toContain("idx_events_run_id");
    expect(names).toContain("idx_events_ts");
    expect(names).toContain("idx_events_category");
  });
});

// ── upsertRun ────────────────────────────────────────────────────────────────

describe("upsertRun", () => {
  it("inserts a new run", () => {
    upsertRun(db, RUN_A);
    const row = db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get("run-aaa") as
      | Record<string, unknown>
      | undefined;
    expect(row).toBeDefined();
    expect(row?.workflow).toBe("fullstack");
    expect(row?.goal).toBe("Build login page");
    expect(row?.status).toBe("running");
    expect(row?.iteration).toBe(2);
  });

  it("updates mutable fields on conflict", () => {
    upsertRun(db, RUN_A);
    upsertRun(db, {
      ...RUN_A,
      status: "succeeded",
      currentStep: "done",
      iteration: 3,
      updatedAt: "2026-04-14T11:00:00.000Z",
    });
    const row = db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get("run-aaa") as
      | Record<string, unknown>
      | undefined;
    expect(row?.status).toBe("succeeded");
    expect(row?.current_step).toBe("done");
    expect(row?.iteration).toBe(3);
    expect(row?.updated_at).toBe("2026-04-14T11:00:00.000Z");
  });

  it("does not overwrite created_at on update", () => {
    upsertRun(db, RUN_A);
    upsertRun(db, { ...RUN_A, status: "failed", updatedAt: "2026-04-14T12:00:00.000Z" });
    const row = db.prepare(`SELECT created_at FROM runs WHERE run_id = ?`).get("run-aaa") as
      | Record<string, unknown>
      | undefined;
    expect(row?.created_at).toBe("2026-04-14T10:00:00.000Z");
  });
});

// ── insertEvent ───────────────────────────────────────────────────────────────

describe("insertEvent", () => {
  beforeEach(() => {
    upsertRun(db, RUN_A);
  });

  it("inserts an event and stores payload as JSON string", () => {
    insertEvent(db, makeEvent());
    const row = db.prepare(`SELECT * FROM events WHERE run_id = ?`).get("run-aaa") as
      | Record<string, unknown>
      | undefined;
    expect(row).toBeDefined();
    expect(row?.category).toBe("lifecycle");
    expect(row?.type).toBe("step.started");
    expect(JSON.parse(row?.payload as string)).toEqual({ step: "implement" });
  });

  it("stores optional fields as NULL when omitted", () => {
    insertEvent(db, makeEvent({ step: undefined, agentName: undefined, summary: undefined }));
    const row = db.prepare(`SELECT step, agent_name, summary FROM events WHERE run_id = ?`).get(
      "run-aaa"
    ) as Record<string, unknown> | undefined;
    expect(row?.step).toBeNull();
    expect(row?.agent_name).toBeNull();
    expect(row?.summary).toBeNull();
  });
});

// ── listRuns ─────────────────────────────────────────────────────────────────

describe("listRuns", () => {
  it("returns runs ordered by updated_at DESC", () => {
    upsertRun(db, RUN_A); // updated_at: 10:05
    upsertRun(db, RUN_B); // updated_at: 09:30
    const runs = listRuns(db) as Array<Record<string, unknown>>;
    expect(runs[0].run_id).toBe("run-aaa");
    expect(runs[1].run_id).toBe("run-bbb");
  });

  it("respects limit and offset", () => {
    upsertRun(db, RUN_A);
    upsertRun(db, RUN_B);
    const page1 = listRuns(db, 1, 0) as Array<Record<string, unknown>>;
    const page2 = listRuns(db, 1, 1) as Array<Record<string, unknown>>;
    expect(page1).toHaveLength(1);
    expect(page2).toHaveLength(1);
    expect(page1[0].run_id).not.toBe(page2[0].run_id);
  });

  it("returns empty array when no runs exist", () => {
    expect(listRuns(db)).toEqual([]);
  });
});

// ── getRun ────────────────────────────────────────────────────────────────────

describe("getRun", () => {
  it("returns the run for a known runId", () => {
    upsertRun(db, RUN_A);
    const run = getRun(db, "run-aaa") as Record<string, unknown> | undefined;
    expect(run?.run_id).toBe("run-aaa");
  });

  it("returns undefined for an unknown runId", () => {
    expect(getRun(db, "does-not-exist")).toBeUndefined();
  });
});

// ── getEvents ─────────────────────────────────────────────────────────────────

describe("getEvents", () => {
  beforeEach(() => {
    upsertRun(db, RUN_A);
    insertEvent(db, makeEvent({ ts: "2026-04-14T10:01:00.000Z", category: "lifecycle", type: "step.started" }));
    insertEvent(db, makeEvent({ ts: "2026-04-14T10:02:00.000Z", category: "tool_call", type: "tool.exec" }));
    insertEvent(db, makeEvent({ ts: "2026-04-14T10:03:00.000Z", category: "lifecycle", type: "step.ended" }));
  });

  it("returns all events for a run when no filters", () => {
    const events = getEvents(db, "run-aaa");
    expect(events).toHaveLength(3);
  });

  it("filters by category", () => {
    const events = getEvents(db, "run-aaa", { category: "lifecycle" });
    expect(events).toHaveLength(2);
    (events as Array<Record<string, unknown>>).forEach((e) =>
      expect(e.category).toBe("lifecycle")
    );
  });

  it("filters by since timestamp (inclusive)", () => {
    const events = getEvents(db, "run-aaa", { since: "2026-04-14T10:02:00.000Z" });
    expect(events).toHaveLength(2);
  });

  it("returns events ordered by ts ASC", () => {
    const events = getEvents(db, "run-aaa") as Array<Record<string, unknown>>;
    expect(events[0].ts < events[1].ts).toBe(true);
    expect(events[1].ts < events[2].ts).toBe(true);
  });

  it("respects limit and offset", () => {
    const page = getEvents(db, "run-aaa", { limit: 2, offset: 1 });
    expect(page).toHaveLength(2);
  });
});

// ── countEvents ───────────────────────────────────────────────────────────────

describe("countEvents", () => {
  it("returns 0 for a run with no events", () => {
    upsertRun(db, RUN_A);
    expect(countEvents(db, "run-aaa")).toBe(0);
  });

  it("returns correct count after insertions", () => {
    upsertRun(db, RUN_A);
    insertEvent(db, makeEvent());
    insertEvent(db, makeEvent({ ts: "2026-04-14T10:02:00.000Z" }));
    expect(countEvents(db, "run-aaa")).toBe(2);
  });
});
```

### Steps

1. **Write tests** — create `tests/unit/server/storage.test.ts`. Run `pnpm test tests/unit/server/storage.test.ts` and confirm failure (module not found).
2. **Verify fail** — error: `Cannot find module '../../../server/storage.js'`.
3. **Add dependency** — `pnpm add better-sqlite3` and `pnpm add -D @types/better-sqlite3`.
4. **Implement** — create `server/storage.ts` as shown. Replace the stub from Task 1 with the real implementation.
5. **Run tests** — `pnpm test tests/unit/server/storage.test.ts`. All tests should pass.
6. **Run full suite** — `pnpm test` to confirm Task 1 tests still pass with the real `openDb`.
7. **Commit** — `git commit -m "feat: SQLite storage layer for runs and events"`

---

## Task 3: REST API Routes

### Files

- `server/routes.ts`
- `tests/unit/server/routes.test.ts`

### `server/routes.ts`

```typescript
import type { FastifyInstance } from "fastify";
import type { Db } from "./storage.js";
import {
  listRuns,
  getRun,
  getEvents,
  countEvents,
  upsertRun,
  insertEvent,
} from "./storage.js";
import type { ServerOptions } from "./types.js";
import type { EngteamEvent } from "../src/types.js";

export function registerRoutes(
  app: FastifyInstance,
  db: Db,
  _opts: ServerOptions
): void {
  // Register a content-type parser so Fastify accepts application/x-ndjson
  // as a raw string rather than trying to JSON.parse the whole body.
  app.addContentTypeParser(
    "application/x-ndjson",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body);
    }
  );

  // ── Health ────────────────────────────────────────────────────────────────

  app.get("/health", async () => ({ ok: true }));

  // ── Runs ──────────────────────────────────────────────────────────────────

  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    "/runs",
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? "50", 10), 200);
      const offset = parseInt(req.query.offset ?? "0", 10);
      return { runs: listRuns(db, limit, offset) };
    }
  );

  app.get<{ Params: { runId: string } }>(
    "/runs/:runId",
    async (req, reply) => {
      const run = getRun(db, req.params.runId);
      if (!run) return reply.status(404).send({ error: "Run not found" });
      return { run };
    }
  );

  // ── Events for a run ──────────────────────────────────────────────────────

  app.get<{
    Params: { runId: string };
    Querystring: {
      limit?: string;
      offset?: string;
      category?: string;
      since?: string;
    };
  }>("/runs/:runId/events", async (req, reply) => {
    const run = getRun(db, req.params.runId);
    if (!run) return reply.status(404).send({ error: "Run not found" });

    const events = getEvents(db, req.params.runId, {
      limit: parseInt(req.query.limit ?? "200", 10),
      offset: parseInt(req.query.offset ?? "0", 10),
      category: req.query.category,
      since: req.query.since,
    });
    const total = countEvents(db, req.params.runId);
    return { events, total };
  });

  // ── Ingest via HTTP POST (HttpSink) ───────────────────────────────────────

  app.post<{ Body: string }>(
    "/events",
    async (req, reply) => {
      const body = req.body as string;
      if (!body) return reply.status(400).send({ error: "Empty body" });

      const lines = body.trim().split("\n").filter(Boolean);
      let inserted = 0;
      const errors: string[] = [];

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as EngteamEvent;
          insertEvent(db, {
            runId: event.runId,
            ts: event.ts,
            category: event.category,
            type: event.type,
            step: event.step,
            agentName: event.agentName,
            summary: event.summary,
            payload: event.payload,
          });
          inserted++;
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }

      return { inserted, errors };
    }
  );

  // ── Stats ─────────────────────────────────────────────────────────────────

  app.get("/stats", async () => {
    const runs = db
      .prepare("SELECT status, COUNT(*) as n FROM runs GROUP BY status")
      .all();
    const eventCount = (
      db.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number }
    ).n;
    return { runs, eventCount };
  });
}
```

**Notes:**
- The `addContentTypeParser` call for `application/x-ndjson` must be registered before route handlers that consume it. Fastify processes content-type parsers before routing.
- The `/events` POST endpoint is the `HttpSink` ingest path. It processes lines individually so a single malformed line does not abort the whole batch — partial ingestion is acceptable and the `errors` array allows the caller to detect and retry failed lines.
- `upsertRun` is imported but not called directly from any route in this initial version. The `/events` POST ingest path relies on the run already existing (created when the watcher ingests `state.json` — covered in a future section). Importing it here keeps the import surface consistent and available for a future `/runs` POST endpoint.
- The `/stats` endpoint uses inline SQL rather than a helper function because it is a one-off aggregation not needed elsewhere.

### `tests/unit/server/routes.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildServer } from "../../../server/server.js";
import { upsertRun } from "../../../server/storage.js";
import type { FastifyInstance } from "fastify";

// Each test gets a fresh server backed by an in-memory SQLite database.
let app: FastifyInstance;

beforeEach(() => {
  app = buildServer({ dbPath: ":memory:", runsDir: "/tmp/runs" });
});

afterEach(async () => {
  await app.close();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = {
  runId: "run-test-001",
  workflow: "fullstack",
  goal: "Test goal",
  status: "running",
  currentStep: "implement",
  iteration: 1,
  createdAt: "2026-04-14T10:00:00.000Z",
  updatedAt: "2026-04-14T10:05:00.000Z",
};

const NDJSON_EVENT = JSON.stringify({
  runId: "run-test-001",
  ts: "2026-04-14T10:01:00.000Z",
  category: "lifecycle",
  type: "step.started",
  payload: { step: "implement" },
});

// ── GET /health ───────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200 with { ok: true }", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

// ── GET /runs ─────────────────────────────────────────────────────────────────

describe("GET /runs", () => {
  it("returns 200 with empty runs array when no runs exist", async () => {
    const res = await app.inject({ method: "GET", url: "/runs" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runs: [] });
  });

  it("returns inserted runs", async () => {
    // Directly seed the db via the exported storage helper.
    // We reach the db through a test-only accessor on the server instance,
    // or we use the upsertRun helper seeded via the same openDb path.
    // Since buildServer creates an in-memory db internally, we must use
    // the POST /events → upsertRun flow or expose the db from buildServer.
    //
    // Simplest approach: expose db on the app instance via decoration.
    // For now, use a workaround: call inject on a POST /runs endpoint
    // (which doesn't exist yet) OR seed via the storage import in the
    // same process by obtaining the db reference.
    //
    // Clean approach: buildServer returns an object { app, db } instead
    // of just app, OR decorate app.db. For this test we use app.inject
    // and POST /events after seeding a run via a direct db call.
    //
    // NOTE: In the actual test file, access the db via app.sqlite if
    // buildServer decorates it (see implementation note below).
    const res = await app.inject({ method: "GET", url: "/runs" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ runs: unknown[] }>();
    expect(Array.isArray(body.runs)).toBe(true);
  });
});

// ── GET /runs/:runId ──────────────────────────────────────────────────────────

describe("GET /runs/:runId", () => {
  it("returns 404 for an unknown runId", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/runs/does-not-exist",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Run not found" });
  });
});

// ── POST /events ──────────────────────────────────────────────────────────────

describe("POST /events", () => {
  it("returns 400 for empty body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/events",
      headers: { "content-type": "application/x-ndjson" },
      body: "",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "Empty body" });
  });

  it("inserts valid NDJSON events and returns inserted count", async () => {
    // Seed the run first (FK constraint) using the db decorator.
    // buildServer must call app.decorate("sqlite", db) for this to work.
    // See implementation note in routes.ts — decorate the db on app.
    const db = (app as unknown as { sqlite: import("better-sqlite3").Database }).sqlite;
    upsertRun(db, RUN);

    const res = await app.inject({
      method: "POST",
      url: "/events",
      headers: { "content-type": "application/x-ndjson" },
      body: NDJSON_EVENT,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ inserted: number; errors: string[] }>();
    expect(body.inserted).toBe(1);
    expect(body.errors).toHaveLength(0);
  });

  it("reports parse errors without aborting valid lines", async () => {
    const db = (app as unknown as { sqlite: import("better-sqlite3").Database }).sqlite;
    upsertRun(db, RUN);

    const badLine = "not valid json";
    const twoLines = `${badLine}\n${NDJSON_EVENT}`;

    const res = await app.inject({
      method: "POST",
      url: "/events",
      headers: { "content-type": "application/x-ndjson" },
      body: twoLines,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ inserted: number; errors: string[] }>();
    expect(body.inserted).toBe(1);
    expect(body.errors).toHaveLength(1);
  });
});

// ── GET /runs/:runId/events ────────────────────────────────────────────────────

describe("GET /runs/:runId/events", () => {
  it("returns 404 for unknown run", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/runs/does-not-exist/events",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns events and total count for a known run", async () => {
    const db = (app as unknown as { sqlite: import("better-sqlite3").Database }).sqlite;
    upsertRun(db, RUN);

    // Seed one event via the ingest endpoint.
    await app.inject({
      method: "POST",
      url: "/events",
      headers: { "content-type": "application/x-ndjson" },
      body: NDJSON_EVENT,
    });

    const res = await app.inject({
      method: "GET",
      url: `/runs/${RUN.runId}/events`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ events: unknown[]; total: number }>();
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
  });
});

// ── GET /stats ─────────────────────────────────────────────────────────────────

describe("GET /stats", () => {
  it("returns runs breakdown and total event count", async () => {
    const res = await app.inject({ method: "GET", url: "/stats" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ runs: unknown[]; eventCount: number }>();
    expect(Array.isArray(body.runs)).toBe(true);
    expect(typeof body.eventCount).toBe("number");
  });
});
```

**Implementation note — db decorator:**

The tests above access the in-memory db via `app.sqlite`. This requires a small change to `server/server.ts`:

```typescript
// server/server.ts  (updated)
import Fastify, { FastifyInstance } from "fastify";
import { openDb, type Db } from "./storage.js";
import { registerRoutes } from "./routes.js";
import type { ServerOptions } from "./types.js";

declare module "fastify" {
  interface FastifyInstance {
    sqlite: Db;
  }
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const db = openDb(opts.dbPath);
  app.decorate("sqlite", db);
  registerRoutes(app, db, opts);
  return app;
}
```

This decoration is a standard Fastify pattern for sharing state across plugins and tests without breaking encapsulation.

### Steps

1. **Write tests** — create `tests/unit/server/routes.test.ts`. Run `pnpm test tests/unit/server/routes.test.ts` and confirm failures (module resolution and missing routes).
2. **Verify fail** — expected: missing routes return 404 where tests expect 200, or module-level errors.
3. **Implement** — create `server/routes.ts` as shown. Update `server/server.ts` to add `app.decorate("sqlite", db)` and the module augmentation.
4. **Run route tests** — `pnpm test tests/unit/server/routes.test.ts`. All tests should pass.
5. **Run full suite** — `pnpm test` to confirm all three test files pass together.
6. **Commit** — `git commit -m "feat: REST API routes for runs, events, and stats"`

---

## Task 4: Build Configuration

### Files modified

- `tsup.config.ts`
- `package.json`

### `tsup.config.ts`

Replace the existing single-entry config with an array of two configs:

```typescript
import { defineConfig } from "tsup";

export default defineConfig([
  // Extension bundle (existing)
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node20",
    bundle: true,
    splitting: false,
    dts: true,
    sourcemap: true,
    clean: true,
    external: ["@mariozechner/pi-coding-agent"],
    outDir: "dist",
  },
  // Observability server bundle (new)
  {
    entry: { server: "server/index.ts" },
    format: ["esm"],
    target: "node20",
    bundle: true,
    splitting: false,
    dts: false,
    external: ["better-sqlite3"],
    outDir: "dist",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
```

**Notes:**
- `better-sqlite3` is marked external because it ships native `.node` bindings that cannot be bundled — the package must be present in `node_modules` at runtime.
- `dts: false` for the server bundle — the server is an executable, not a library; there are no consumers of its TypeScript types.
- `banner: { js: "#!/usr/bin/env node" }` injects the shebang into `dist/server.js` so `chmod +x dist/server.js` and direct execution work correctly. The source file does not carry the shebang (it would be a TS syntax error).
- `clean: true` is kept only on the first entry to avoid the second pass wiping the first pass's output. Alternatively, move `clean: true` to only the first entry or manage it via a pre-build script.

### `package.json` additions

Add the following fields to the existing `package.json`:

```json
{
  "bin": {
    "pi-engteam-server": "./dist/server.js"
  },
  "dependencies": {
    "@sinclair/typebox": "^0.34.0",
    "shell-quote": "^1.8.1",
    "fastify": "^5.0.0",
    "better-sqlite3": "^9.0.0"
  },
  "devDependencies": {
    "@mariozechner/pi-coding-agent": "^0.67.0",
    "@mariozechner/pi-ai": "^0.67.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "@types/shell-quote": "^1.7.4",
    "tsup": "^8.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

**Notes:**
- `fastify` moves to `dependencies` (not devDependencies) because it is required at runtime inside the bundle. Even though tsup bundles Fastify into `dist/server.js`, keeping it in `dependencies` documents the runtime requirement and ensures correct behaviour when the package is published.
- `better-sqlite3` must be in `dependencies` because it is external to the bundle and must be installed alongside the package.
- `@types/better-sqlite3` goes in `devDependencies` — types are only needed at compile time.

### Steps

1. **Install new dependencies** — `pnpm add fastify better-sqlite3` and `pnpm add -D @types/better-sqlite3`.
2. **Update tsup.config.ts** — replace single-object config with the two-entry array shown above.
3. **Update package.json** — add `bin`, `fastify`, `better-sqlite3`, and `@types/better-sqlite3` entries.
4. **Build** — `pnpm build`. Verify `dist/server.js` is created and starts with `#!/usr/bin/env node`.
5. **Smoke test the binary** — `node dist/server.js &` — should print `[pi-engteam-server] Listening on http://127.0.0.1:4747`. Kill with `kill %1`.
6. **Run full test suite** — `pnpm test` to confirm no regressions from the config change.
7. **Commit** — `git commit -m "build: add server entry to tsup config and update package.json"`

---

## Summary Checklist

| Task | New files | Modified files | Tests | Commit message |
|------|-----------|----------------|-------|----------------|
| 1 — Server scaffold | `server/types.ts`, `server/index.ts`, `server/server.ts`, `tests/unit/server/server.test.ts` | — | 2 | `feat: server scaffold with Fastify app factory` |
| 2 — SQLite storage | `server/storage.ts`, `tests/unit/server/storage.test.ts` | `server/server.ts` (real openDb) | 14 | `feat: SQLite storage layer for runs and events` |
| 3 — REST routes | `server/routes.ts`, `tests/unit/server/routes.test.ts` | `server/server.ts` (db decorator) | 9 | `feat: REST API routes for runs, events, and stats` |
| 4 — Build config | — | `tsup.config.ts`, `package.json` | (build smoke test) | `build: add server entry to tsup config and update package.json` |

**Total new test cases: ~25**

---

## Dependency Installation Order

```bash
# Task 2 — add before implementing storage.ts
pnpm add better-sqlite3
pnpm add -D @types/better-sqlite3

# Task 3 — add before implementing routes.ts
pnpm add fastify
```

Running `pnpm add` before writing the implementation ensures TypeScript can resolve the module imports immediately, keeping red-underline noise to a minimum during development.

---

## Cross-cutting Concerns

### TypeScript config

The existing `tsconfig.json` has `"rootDir": "src"` and `"include": ["src/**/*"]`. The `server/` directory is outside `src/`. Two options:

**Option A** (recommended): Add a `tsconfig.server.json` that extends the base config and sets `"rootDir": "."` and `"include": ["src/**/*", "server/**/*"]`. tsup uses its own transpilation pipeline so this only matters for `tsc --noEmit` type checking.

```json
// tsconfig.server.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src/**/*", "server/**/*"]
}
```

Update `package.json` scripts:

```json
"typecheck": "tsc --noEmit && tsc -p tsconfig.server.json --noEmit"
```

**Option B**: Widen the base `tsconfig.json` to include `server/**/*` and change `rootDir` to `"."`. Simpler, but slightly looser.

### Vitest config

The existing `vitest.config.ts` includes `tests/**/*.test.ts` which already covers `tests/unit/server/*.test.ts` — no change needed.

### better-sqlite3 and vitest

`better-sqlite3` uses native Node.js addons (`.node` files). Vitest runs in Node and handles these correctly by default. No special configuration is needed. If tests are ever run in a browser-like environment (e.g. jsdom), `better-sqlite3` would fail — the existing `environment: "node"` in `vitest.config.ts` prevents this.


---

# pi-engteam Plan C2: Bundled SQLite Observability Server — Watcher, Dashboard, and /observe Command

## Overview

Plan C2 extends the observability server established in Plan C1. C1 produced:

- `server/server.ts` — Fastify app factory (`buildServer({ dbPath, runsDir })`)
- `server/storage.ts` — SQLite layer (`openDb`, `upsertRun`, `insertEvent`, `listRuns`, `getRun`, `getEvents`, `countEvents`)
- `server/routes.ts` — REST API: `GET /health`, `GET /runs`, `GET /runs/:id`, `GET /runs/:id/events`, `POST /events`, `GET /stats`
- `server/types.ts` — `ServerOptions = { dbPath: string; runsDir: string }`
- `server/index.ts` — CLI entry point

C2 adds three capabilities:

1. **Task 5** — `EventWatcher`: tails `events.jsonl` files in `runsDir` and ingests into SQLite
2. **Task 6** — HTML dashboard served at `GET /`
3. **Task 7** — `/observe` Pi slash command that starts the server on demand
4. **Task 8** — End-to-end integration test for the watcher
5. **Task 9** — Final build verification and smoke test

**Tech stack:** Node.js `fs.watch` (recursive), `better-sqlite3`, TypeScript/ESM, Vitest, tsup.

---

## Task 5: JSONL Watcher

### Files

- `server/watcher.ts` — `EventWatcher` class
- `server/server.ts` — updated to wire watcher into Fastify lifecycle hooks
- `tests/unit/server/watcher.test.ts` — Vitest unit tests

### Implementation

#### `server/watcher.ts`

```typescript
import { watch, createReadStream, statSync } from "fs";
import { readdir } from "fs/promises";
import { join } from "path";
import { createInterface } from "readline";
import type { Db } from "./storage.js";
import { insertEvent, upsertRun } from "./storage.js";
import type { EngteamEvent } from "../src/types.js";

type FileState = { offset: number };

export class EventWatcher {
  private fileStates = new Map<string, FileState>();
  private watchers: ReturnType<typeof watch>[] = [];

  constructor(
    private runsDir: string,
    private db: Db,
  ) {}

  async start(): Promise<void> {
    // Initial scan of existing files
    await this.scanDir(this.runsDir);

    // Watch for new files and changes
    try {
      const w = watch(this.runsDir, { recursive: true }, (_event, filename) => {
        if (filename?.endsWith("events.jsonl")) {
          const fullPath = join(this.runsDir, filename);
          void this.ingestFile(fullPath);
        }
      });
      this.watchers.push(w);
    } catch {
      // fs.watch with recursive not supported on all platforms — fall back to polling
      setInterval(() => { void this.scanDir(this.runsDir); }, 2000);
    }
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  private async scanDir(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.scanDir(full);
        } else if (entry.name === "events.jsonl") {
          await this.ingestFile(full);
        }
      }
    } catch {
      // directory may not exist yet
    }
  }

  async ingestFile(filePath: string): Promise<void> {
    const state = this.fileStates.get(filePath) ?? { offset: 0 };

    let fileSize = 0;
    try {
      fileSize = statSync(filePath).size;
    } catch {
      return;
    }

    if (fileSize <= state.offset) return;

    const lines: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, {
        start: state.offset,
        encoding: "utf8",
      });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line) => { if (line.trim()) lines.push(line); });
      rl.on("close", resolve);
      rl.on("error", reject);
    });

    state.offset = fileSize;
    this.fileStates.set(filePath, state);

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as EngteamEvent;
        insertEvent(this.db, {
          runId: event.runId,
          ts: event.ts,
          category: event.category,
          type: event.type,
          step: event.step,
          agentName: event.agentName,
          summary: event.summary,
          payload: event.payload,
        });

        // Sync run metadata from lifecycle events
        if (
          event.category === "lifecycle" &&
          (event.type === "run.start" || event.type === "run.end")
        ) {
          const p = event.payload as any;
          upsertRun(this.db, {
            runId: event.runId,
            workflow: p.workflow ?? "unknown",
            goal: p.goal ?? "",
            status: event.type === "run.end" ? (p.status ?? "succeeded") : "running",
            currentStep: p.currentStep,
            iteration: p.iteration ?? 0,
            createdAt: event.ts,
            updatedAt: event.ts,
          });
        }
      } catch {
        // Skip malformed lines
      }
    }
  }
}
```

#### `server/server.ts` (updated)

Add watcher lifecycle hooks after the existing route registration:

```typescript
import { EventWatcher } from "./watcher.js";

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const db = openDb(opts.dbPath);
  const watcher = new EventWatcher(opts.runsDir, db);

  registerRoutes(app, db, opts);

  app.addHook("onReady", async () => {
    await watcher.start();
  });

  app.addHook("onClose", async () => {
    watcher.stop();
  });

  return app;
}
```

### Tests: `tests/unit/server/watcher.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, appendFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { openDb, listRuns, getEvents } from "../../../server/storage.js";
import { EventWatcher } from "../../../server/watcher.js";

function makeEvent(
  runId: string,
  category: string,
  type: string,
  extraPayload: Record<string, unknown> = {},
): string {
  return (
    JSON.stringify({
      ts: new Date().toISOString(),
      runId,
      category,
      type,
      payload: extraPayload,
    }) + "\n"
  );
}

describe("EventWatcher", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "watcher-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("ingests all lines from an events.jsonl file", async () => {
    const db = openDb(":memory:");
    const runDir = join(tmpDir, "run-1");
    await mkdir(runDir, { recursive: true });
    const filePath = join(runDir, "events.jsonl");

    await writeFile(
      filePath,
      makeEvent("run-1", "tool_call", "bash.start") +
        makeEvent("run-1", "tool_result", "bash.end") +
        makeEvent("run-1", "message", "agent.msg"),
    );

    const watcher = new EventWatcher(tmpDir, db);
    await watcher.ingestFile(filePath);

    const events = getEvents(db, "run-1");
    expect(events).toHaveLength(3);
  });

  it("tracks byte offset and only ingests new lines on subsequent calls", async () => {
    const db = openDb(":memory:");
    const runDir = join(tmpDir, "run-2");
    await mkdir(runDir, { recursive: true });
    const filePath = join(runDir, "events.jsonl");

    await writeFile(filePath, makeEvent("run-2", "tool_call", "bash.start"));

    const watcher = new EventWatcher(tmpDir, db);
    await watcher.ingestFile(filePath);

    expect(getEvents(db, "run-2")).toHaveLength(1);

    // Append two more events
    await appendFile(
      filePath,
      makeEvent("run-2", "tool_call", "bash.start") +
        makeEvent("run-2", "tool_result", "bash.end"),
    );
    await watcher.ingestFile(filePath);

    // Total should now be 3, not 5 (no re-read of already-consumed bytes)
    expect(getEvents(db, "run-2")).toHaveLength(3);
  });

  it("does not re-ingest events when file has not grown", async () => {
    const db = openDb(":memory:");
    const runDir = join(tmpDir, "run-3");
    await mkdir(runDir, { recursive: true });
    const filePath = join(runDir, "events.jsonl");

    await writeFile(filePath, makeEvent("run-3", "tool_call", "bash.start"));

    const watcher = new EventWatcher(tmpDir, db);
    await watcher.ingestFile(filePath);
    await watcher.ingestFile(filePath); // second call — same size

    expect(getEvents(db, "run-3")).toHaveLength(1);
  });

  it("calls upsertRun when a run.start lifecycle event is ingested", async () => {
    const db = openDb(":memory:");
    const runDir = join(tmpDir, "run-4");
    await mkdir(runDir, { recursive: true });
    const filePath = join(runDir, "events.jsonl");

    await writeFile(
      filePath,
      makeEvent("run-4", "lifecycle", "run.start", {
        workflow: "plan-build-review",
        goal: "Build the widget",
        iteration: 0,
      }),
    );

    const watcher = new EventWatcher(tmpDir, db);
    await watcher.ingestFile(filePath);

    const runs = listRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0].run_id).toBe("run-4");
    expect(runs[0].status).toBe("running");
    expect(runs[0].workflow).toBe("plan-build-review");
  });

  it("sets run status to succeeded when a run.end lifecycle event is ingested", async () => {
    const db = openDb(":memory:");
    const runDir = join(tmpDir, "run-5");
    await mkdir(runDir, { recursive: true });
    const filePath = join(runDir, "events.jsonl");

    await writeFile(
      filePath,
      makeEvent("run-5", "lifecycle", "run.start", {
        workflow: "plan-build-review",
        goal: "Done goal",
        iteration: 1,
      }) +
        makeEvent("run-5", "lifecycle", "run.end", {
          status: "succeeded",
          iteration: 1,
        }),
    );

    const watcher = new EventWatcher(tmpDir, db);
    await watcher.ingestFile(filePath);

    const runs = listRuns(db);
    expect(runs[0].status).toBe("succeeded");
  });

  it("silently skips malformed JSON lines", async () => {
    const db = openDb(":memory:");
    const runDir = join(tmpDir, "run-6");
    await mkdir(runDir, { recursive: true });
    const filePath = join(runDir, "events.jsonl");

    await writeFile(
      filePath,
      makeEvent("run-6", "tool_call", "bash.start") +
        "NOT VALID JSON\n" +
        makeEvent("run-6", "tool_result", "bash.end"),
    );

    const watcher = new EventWatcher(tmpDir, db);
    await watcher.ingestFile(filePath);

    // 2 valid events ingested; malformed line skipped without throwing
    expect(getEvents(db, "run-6")).toHaveLength(2);
  });

  it("returns immediately if file does not exist", async () => {
    const db = openDb(":memory:");
    const watcher = new EventWatcher(tmpDir, db);
    // Should not throw
    await expect(
      watcher.ingestFile(join(tmpDir, "nonexistent", "events.jsonl")),
    ).resolves.toBeUndefined();
  });
});
```

### TDD Steps

1. **Write tests** — create `tests/unit/server/watcher.test.ts` with the full test suite above.
2. **Verify red** — run `pnpm test tests/unit/server/watcher.test.ts`; all tests must fail with module-not-found or type errors since `server/watcher.ts` does not exist yet.
3. **Implement** — create `server/watcher.ts` with the `EventWatcher` class.
4. **Wire into server** — update `server/server.ts` to import `EventWatcher` and attach `onReady`/`onClose` hooks.
5. **Run tests** — `pnpm test tests/unit/server/watcher.test.ts`; all 7 tests should pass.
6. **Run full suite** — `pnpm test`; verify no regressions.
7. **Commit:**

```
feat: EventWatcher tails events.jsonl files into SQLite
```

---

## Task 6: Minimal HTML Dashboard

### Files

- `server/dashboard.ts` — `getDashboardHtml(baseUrl)` function
- `server/types.ts` — add optional `port?: number` to `ServerOptions`
- `server/routes.ts` — add `GET /` route serving the dashboard
- `tests/unit/server/dashboard.test.ts` — Vitest unit tests

### Implementation

#### `server/types.ts` (updated)

```typescript
export type ServerOptions = {
  dbPath: string;
  runsDir: string;
  port?: number; // default 4747
};
```

#### `server/dashboard.ts`

```typescript
export function getDashboardHtml(baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>pi-engteam observer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; background: #0f0f0f; color: #e0e0e0; padding: 24px; }
  h1 { color: #7c6af7; margin-bottom: 16px; font-size: 1.4rem; }
  .stats { display: flex; gap: 16px; margin-bottom: 24px; }
  .stat { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 12px 20px; }
  .stat-label { font-size: 0.75rem; color: #888; text-transform: uppercase; }
  .stat-value { font-size: 1.6rem; font-weight: bold; color: #e0e0e0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #222; font-size: 0.85rem; }
  th { color: #888; font-weight: 500; text-transform: uppercase; font-size: 0.7rem; }
  tr:hover td { background: #1a1a1a; }
  .status-succeeded { color: #4ade80; }
  .status-failed { color: #f87171; }
  .status-running { color: #60a5fa; }
  .status-aborted { color: #fbbf24; }
  .refresh-btn { background: #7c6af7; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-bottom: 16px; }
  .refresh-btn:hover { background: #6c5ad7; }
</style>
</head>
<body>
<h1>pi-engteam observer</h1>
<div class="stats" id="stats">Loading...</div>
<button class="refresh-btn" onclick="load()">Refresh</button>
<table>
  <thead><tr><th>Run ID</th><th>Workflow</th><th>Goal</th><th>Status</th><th>Step</th><th>Iter</th><th>Updated</th></tr></thead>
  <tbody id="runs-body"></tbody>
</table>
<script>
const API = '${baseUrl}';
async function load() {
  const [statsRes, runsRes] = await Promise.all([
    fetch(API + '/stats').then(r => r.json()),
    fetch(API + '/runs?limit=50').then(r => r.json()),
  ]);

  const statsByStatus = Object.fromEntries(statsRes.runs.map(r => [r.status, r.n]));
  const total = statsRes.eventCount;
  document.getElementById('stats').innerHTML = [
    ['Total Events', total],
    ['Running', statsByStatus.running ?? 0],
    ['Succeeded', statsByStatus.succeeded ?? 0],
    ['Failed', statsByStatus.failed ?? 0],
  ].map(([l, v]) => '<div class="stat"><div class="stat-label">' + l + '</div><div class="stat-value">' + v + '</div></div>').join('');

  document.getElementById('runs-body').innerHTML = runsRes.runs.map(r =>
    '<tr>' +
    '<td><a href="' + API + '/runs/' + r.run_id + '/events" style="color:#7c6af7">' + r.run_id.slice(0, 8) + '</a></td>' +
    '<td>' + r.workflow + '</td>' +
    '<td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + r.goal + '">' + r.goal + '</td>' +
    '<td class="status-' + r.status + '">' + r.status + '</td>' +
    '<td>' + (r.current_step ?? '-') + '</td>' +
    '<td>' + (r.iteration ?? 0) + '</td>' +
    '<td>' + new Date(r.updated_at).toLocaleTimeString() + '</td>' +
    '</tr>'
  ).join('');
}
load();
setInterval(load, 5000);
</script>
</body>
</html>`;
}
```

#### `server/routes.ts` (updated — add dashboard route)

Add the following import at the top of `server/routes.ts`:

```typescript
import { getDashboardHtml } from "./dashboard.js";
```

Add the dashboard route inside `registerRoutes`, before or after the `/health` route:

```typescript
// Serve HTML dashboard
app.get("/", async (_req, reply) => {
  const port = opts.port ?? 4747;
  const html = getDashboardHtml(`http://127.0.0.1:${port}`);
  reply.type("text/html").send(html);
});
```

### Tests: `tests/unit/server/dashboard.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { getDashboardHtml } from "../../../server/dashboard.js";

describe("getDashboardHtml", () => {
  const BASE_URL = "http://localhost:4747";
  let html: string;

  it("returns a string", () => {
    html = getDashboardHtml(BASE_URL);
    expect(typeof html).toBe("string");
  });

  it("starts with a valid HTML doctype declaration", () => {
    html = getDashboardHtml(BASE_URL);
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
  });

  it("contains the <html> root element", () => {
    html = getDashboardHtml(BASE_URL);
    expect(html).toContain("<html");
  });

  it("contains the page title 'pi-engteam observer'", () => {
    html = getDashboardHtml(BASE_URL);
    expect(html).toContain("pi-engteam observer");
  });

  it("embeds the provided baseUrl in the script block", () => {
    html = getDashboardHtml(BASE_URL);
    expect(html).toContain(`const API = '${BASE_URL}'`);
  });

  it("embeds a different baseUrl when called with a different port", () => {
    const customHtml = getDashboardHtml("http://127.0.0.1:9090");
    expect(customHtml).toContain("const API = 'http://127.0.0.1:9090'");
    expect(customHtml).not.toContain("const API = 'http://localhost:4747'");
  });

  it("includes fetch calls to /stats and /runs", () => {
    html = getDashboardHtml(BASE_URL);
    expect(html).toContain("fetch(API + '/stats')");
    expect(html).toContain("fetch(API + '/runs?limit=50')");
  });

  it("includes auto-refresh via setInterval", () => {
    html = getDashboardHtml(BASE_URL);
    expect(html).toContain("setInterval(load, 5000)");
  });

  it("renders status CSS classes for all run statuses", () => {
    html = getDashboardHtml(BASE_URL);
    for (const status of ["succeeded", "failed", "running", "aborted"]) {
      expect(html).toContain(`.status-${status}`);
    }
  });
});
```

### TDD Steps

1. **Write tests** — create `tests/unit/server/dashboard.test.ts`.
2. **Verify red** — run `pnpm test tests/unit/server/dashboard.test.ts`; all tests fail (module not found).
3. **Implement** — create `server/dashboard.ts` with `getDashboardHtml`.
4. **Update types** — add `port?: number` to `ServerOptions` in `server/types.ts`.
5. **Wire route** — import `getDashboardHtml` in `server/routes.ts` and add `GET /` handler.
6. **Run tests** — `pnpm test tests/unit/server/dashboard.test.ts`; all 9 tests pass.
7. **Run full suite** — `pnpm test`; no regressions.
8. **Commit:**

```
feat: minimal HTML dashboard at GET /
```

---

## Task 7: /observe Slash Command

### Files

- `src/commands/observe.ts` — `registerObserveCommand` function
- `src/index.ts` — updated to call `registerObserveCommand(pi)`
- `tests/unit/commands/observe.test.ts` — Vitest unit tests

### Implementation

#### `src/commands/observe.ts`

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export const SERVER_PORT = parseInt(
  process.env.PI_ENGTEAM_SERVER_PORT ?? "4747",
  10,
);

// Module-level singleton: null when no server has been started by this process
export let serverProcess: ReturnType<typeof spawn> | null = null;

export async function isServerRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startServer(port: number): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const serverBin = join(__dirname, "..", "..", "dist", "server.js");

  serverProcess = spawn("node", [serverBin], {
    detached: false,
    stdio: "pipe",
    env: { ...process.env, PI_ENGTEAM_SERVER_PORT: String(port) },
  });

  serverProcess.on("exit", () => {
    serverProcess = null;
  });

  // Wait up to 3 seconds for server to be ready (30 × 100 ms)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isServerRunning(port)) return;
  }
  throw new Error(
    `Server did not start within 3 seconds on port ${port}`,
  );
}

export function registerObserveCommand(pi: ExtensionAPI): void {
  pi.registerCommand({
    name: "observe",
    description:
      "Start the pi-engteam observability server and open the dashboard URL",
    argsSchema: Type.Object({
      stop: Type.Optional(
        Type.Boolean({
          description: "Stop the server instead of starting it",
        }),
      ),
    }),
    handler: async (args, _ctx) => {
      if (args.stop) {
        if (serverProcess) {
          serverProcess.kill();
          serverProcess = null;
          return { message: "Observability server stopped." };
        }
        return { message: "No observability server is running." };
      }

      const already = await isServerRunning(SERVER_PORT);
      if (already) {
        return {
          message: `Observability server already running at http://127.0.0.1:${SERVER_PORT}`,
        };
      }

      await startServer(SERVER_PORT);
      return {
        message: [
          `Observability server started on port ${SERVER_PORT}.`,
          `Dashboard: http://127.0.0.1:${SERVER_PORT}`,
          `API:       http://127.0.0.1:${SERVER_PORT}/runs`,
        ].join("\n"),
      };
    },
  });
}
```

#### `src/index.ts` (updated)

Add the import and call at the bottom of the registration block, before the `session_start` handler:

```typescript
import { registerObserveCommand } from "./commands/observe.js";

// ... existing registrations ...
registerObserveCommand(pi);
```

### Tests: `tests/unit/commands/observe.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock child_process before importing the module under test
// ---------------------------------------------------------------------------
vi.mock("child_process", () => {
  const fakeProcess = {
    on: vi.fn(),
    kill: vi.fn(),
    stdio: "pipe" as const,
  };
  return {
    spawn: vi.fn(() => fakeProcess),
    __fakeProcess: fakeProcess,
  };
});

// ---------------------------------------------------------------------------
// Isolate module state between tests by re-importing with vi.resetModules
// ---------------------------------------------------------------------------
describe("/observe command handler", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'already running' message when server is reachable", async () => {
    // Patch global fetch before importing
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const { isServerRunning } = await import(
      "../../../src/commands/observe.js"
    );
    const result = await isServerRunning(4747);
    expect(result).toBe(true);
  });

  it("returns false when server fetch throws (not running)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mockFetch);

    const { isServerRunning } = await import(
      "../../../src/commands/observe.js"
    );
    const result = await isServerRunning(4747);
    expect(result).toBe(false);
  });

  it("returns false when server responds with non-ok status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", mockFetch);

    const { isServerRunning } = await import(
      "../../../src/commands/observe.js"
    );
    const result = await isServerRunning(4747);
    expect(result).toBe(false);
  });

  it("handler returns 'already running' message when isServerRunning is true", async () => {
    // Server is already up
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true }),
    );

    const { registerObserveCommand } = await import(
      "../../../src/commands/observe.js"
    );

    let capturedHandler: Function | null = null;
    const fakePi = {
      registerCommand: vi.fn((def: any) => {
        capturedHandler = def.handler;
      }),
    };

    registerObserveCommand(fakePi as any);
    expect(fakePi.registerCommand).toHaveBeenCalledOnce();

    const result = await capturedHandler!({}, {});
    expect(result.message).toMatch(/already running/i);
    expect(result.message).toContain("4747");
  });

  it("handler returns 'stopped' message when stop=true and server process exists", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    const observeModule = await import("../../../src/commands/observe.js");
    const { registerObserveCommand } = observeModule;

    // Inject a fake serverProcess into the module
    const fakeProc = { kill: vi.fn(), on: vi.fn() };
    (observeModule as any).serverProcess = fakeProc;

    let capturedHandler: Function | null = null;
    const fakePi = {
      registerCommand: vi.fn((def: any) => {
        capturedHandler = def.handler;
      }),
    };

    registerObserveCommand(fakePi as any);
    const result = await capturedHandler!({ stop: true }, {});
    expect(result.message).toBe("Observability server stopped.");
    expect(fakeProc.kill).toHaveBeenCalledOnce();
  });

  it("handler returns 'No server running' when stop=true and serverProcess is null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    const { registerObserveCommand } = await import(
      "../../../src/commands/observe.js"
    );

    let capturedHandler: Function | null = null;
    const fakePi = {
      registerCommand: vi.fn((def: any) => {
        capturedHandler = def.handler;
      }),
    };

    registerObserveCommand(fakePi as any);
    // serverProcess starts as null (fresh module)
    const result = await capturedHandler!({ stop: true }, {});
    expect(result.message).toBe("No observability server is running.");
  });

  it("registerCommand is called with name='observe'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const { registerObserveCommand } = await import(
      "../../../src/commands/observe.js"
    );

    const fakePi = { registerCommand: vi.fn() };
    registerObserveCommand(fakePi as any);

    expect(fakePi.registerCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: "observe" }),
    );
  });
});
```

### TDD Steps

1. **Write tests** — create `tests/unit/commands/observe.test.ts`.
2. **Verify red** — run `pnpm test tests/unit/commands/observe.test.ts`; all tests fail (module not found).
3. **Implement** — create `src/commands/observe.ts`.
4. **Wire into index** — add import and `registerObserveCommand(pi)` call in `src/index.ts`.
5. **Run tests** — `pnpm test tests/unit/commands/observe.test.ts`; all tests pass.
6. **Run full suite** — `pnpm test`; no regressions.
7. **Commit:**

```
feat: /observe command to start observability server from Pi
```

---

## Task 8: End-to-End Watcher Integration Test

### Files

- `tests/integration/watcher.test.ts`

### Implementation

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, appendFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { openDb, getEvents, listRuns } from "../../server/storage.js";
import { EventWatcher } from "../../server/watcher.js";

function makeEvent(
  runId: string,
  type: string,
  extraPayload: Record<string, unknown> = {},
): string {
  const category = type.startsWith("run.") ? "lifecycle" : "tool_call";
  return (
    JSON.stringify({
      ts: new Date().toISOString(),
      runId,
      category,
      type,
      payload: { ...extraPayload },
    }) + "\n"
  );
}

describe("EventWatcher end-to-end", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "watcher-integ-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("ingests events from events.jsonl on initial scan", async () => {
    const db = openDb(":memory:");
    const runDir = join(tmpDir, "run-abc");
    await mkdir(runDir, { recursive: true });
    const filePath = join(runDir, "events.jsonl");

    await writeFile(
      filePath,
      makeEvent("run-abc", "run.start", {
        workflow: "plan-build-review",
        goal: "e2e test",
        iteration: 0,
      }) +
        makeEvent("run-abc", "tool_call.start") +
        makeEvent("run-abc", "run.end", { status: "succeeded", iteration: 1 }),
    );

    const watcher = new EventWatcher(tmpDir, db);
    await watcher.ingestFile(filePath);

    const events = getEvents(db, "run-abc");
    expect(events).toHaveLength(3);
  });

  it("tracks offset and only reads new lines on subsequent ingestion", async () => {
    const db = openDb(":memory:");
    const runDir = join(tmpDir, "run-xyz");
    await mkdir(runDir, { recursive: true });
    const filePath = join(runDir, "events.jsonl");

    await writeFile(filePath, makeEvent("run-xyz", "step.start"));
    const watcher = new EventWatcher(tmpDir, db);
    await watcher.ingestFile(filePath);

    await appendFile(filePath, makeEvent("run-xyz", "step.end"));
    await watcher.ingestFile(filePath);

    const events = getEvents(db, "run-xyz");
    expect(events).toHaveLength(2);
  });

  it("initial scanDir picks up events.jsonl files in subdirectories", async () => {
    const db = openDb(":memory:");

    const runDir1 = join(tmpDir, "run-d1");
    const runDir2 = join(tmpDir, "run-d2");
    await mkdir(runDir1, { recursive: true });
    await mkdir(runDir2, { recursive: true });

    await writeFile(
      join(runDir1, "events.jsonl"),
      makeEvent("run-d1", "run.start", {
        workflow: "w1",
        goal: "g1",
        iteration: 0,
      }),
    );
    await writeFile(
      join(runDir2, "events.jsonl"),
      makeEvent("run-d2", "run.start", {
        workflow: "w2",
        goal: "g2",
        iteration: 0,
      }),
    );

    const watcher = new EventWatcher(tmpDir, db);
    await (watcher as any).scanDir(tmpDir);

    const runs = listRuns(db);
    expect(runs.map((r: any) => r.run_id).sort()).toEqual(
      ["run-d1", "run-d2"].sort(),
    );
  });

  it("stop() closes all watchers without throwing", () => {
    const db = openDb(":memory:");
    const watcher = new EventWatcher(tmpDir, db);
    // stop before start — should be a no-op
    expect(() => watcher.stop()).not.toThrow();
  });
});
```

### TDD Steps

1. **Write integration test** — create `tests/integration/watcher.test.ts`.
2. **Verify green** — by this point `server/watcher.ts` and `server/storage.ts` exist (Tasks 5 and C1); run `pnpm test tests/integration/watcher.test.ts` and confirm all 4 tests pass.
3. **Run full suite** — `pnpm test`; confirm all unit and integration tests pass.
4. **Commit:**

```
test: EventWatcher end-to-end integration test
```

---

## Task 9: Final Build and Smoke Test

### Files

- `tsup.config.ts` — updated to include `server/index.ts` as a second entry point
- `package.json` — add `preview:server` script

### Implementation

#### `tsup.config.ts` (updated)

The current tsup config only bundles `src/index.ts`. Add `server/index.ts` as a second entry so `dist/server.js` is produced:

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    server: "server/index.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["@mariozechner/pi-coding-agent", "better-sqlite3"],
});
```

Note: `better-sqlite3` is a native addon and must be listed as external — tsup cannot bundle native `.node` binaries.

#### `tsconfig.json` (updated)

The `include` array currently only covers `src/**/*`. Extend it so TypeScript sees the server directory:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*", "server/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Important:** changing `rootDir` from `"src"` to `"."` is required once `server/` files are added as TypeScript source. Verify that `dist/index.js` and `dist/server.js` are both produced at the correct paths.

#### `package.json` (updated — add preview script)

```json
{
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "preview:server": "node dist/server.js"
  }
}
```

### Verification Steps

1. **Run build** — `pnpm build`
   - Confirm `dist/index.js` exists (Pi extension entry point)
   - Confirm `dist/server.js` exists (standalone server)

2. **Smoke test server binary:**

   ```bash
   node dist/server.js --help
   # or
   node dist/server.js --port 4747 --db /tmp/test.db --runs-dir /tmp/runs &
   sleep 1
   curl -s http://127.0.0.1:4747/health
   # Expected: {"status":"ok"}
   kill %1
   ```

3. **Run full test suite:**

   ```bash
   pnpm test
   ```

   Expected output: all unit and integration tests pass (Tasks 5, 6, 7, 8 + all C1 tests).

4. **Run typecheck:**

   ```bash
   pnpm typecheck
   ```

   Expected: zero errors.

5. **Commit:**

```
build: produce dist/server.js; full test suite passing
```

---

## Summary of All C2 Files

| File | Action | Purpose |
|------|--------|---------|
| `server/watcher.ts` | Create | `EventWatcher` class — tails `events.jsonl` into SQLite |
| `server/dashboard.ts` | Create | `getDashboardHtml(baseUrl)` — self-contained HTML/CSS/JS dashboard |
| `server/types.ts` | Update | Add `port?: number` to `ServerOptions` |
| `server/routes.ts` | Update | Add `GET /` dashboard route |
| `server/server.ts` | Update | Wire `EventWatcher` into `onReady`/`onClose` hooks |
| `src/commands/observe.ts` | Create | `/observe` Pi slash command |
| `src/index.ts` | Update | Register `/observe` command |
| `tsup.config.ts` | Update | Add `server/index.ts` entry point, externalize `better-sqlite3` |
| `tsconfig.json` | Update | Extend `include` to `server/**/*`, change `rootDir` to `"."` |
| `package.json` | Update | Add `preview:server` script |
| `tests/unit/server/watcher.test.ts` | Create | 7 unit tests for `EventWatcher` |
| `tests/unit/server/dashboard.test.ts` | Create | 9 unit tests for `getDashboardHtml` |
| `tests/unit/commands/observe.test.ts` | Create | 6 unit tests for `/observe` handler |
| `tests/integration/watcher.test.ts` | Create | 4 end-to-end integration tests |

## Commit Sequence

```
feat: EventWatcher tails events.jsonl files into SQLite
feat: minimal HTML dashboard at GET /
feat: /observe command to start observability server from Pi
test: EventWatcher end-to-end integration test
build: produce dist/server.js; full test suite passing
```


---

