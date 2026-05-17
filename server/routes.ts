import type { FastifyInstance } from "fastify";
import type { Db } from "./storage.js";
import { listRuns, getRun, getEvents, countEvents, insertEvent, upsertRun } from "./storage.js";
import type { ServerOptions } from "./types.js";
import type { EngteamEvent } from "../src/types.js";
import { getDashboardHtml } from "./dashboard.js";

export function registerRoutes(app: FastifyInstance, db: Db, opts: ServerOptions & { port: number }): void {
  app.addContentTypeParser("application/x-ndjson", { parseAs: "string" }, (_req, body, done) => { done(null, body); });

  app.get("/", async (_req, reply) => {
    reply.type("text/html").send(getDashboardHtml(`http://127.0.0.1:${opts.port}`));
  });

  app.get("/health", async () => ({ ok: true }));

  // Codex round-16 MEDIUM: previous parseInt-based limit/offset accepted
  // negative values (LIMIT -1 = unbounded in SQLite) and NaN (datatype
  // mismatch crash). Clamp to safe bounds before hitting SQL.
  const parseBoundedInt = (raw: string | undefined, fallback: number, min: number, max: number): number => {
    if (raw === undefined) return fallback;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  };

  app.get<{ Querystring: { limit?: string; offset?: string } }>("/runs", async (req) => {
    const limit = parseBoundedInt(req.query.limit, 50, 1, 200);
    const offset = parseBoundedInt(req.query.offset, 0, 0, 1_000_000);
    return { runs: listRuns(db, limit, offset) };
  });

  app.get<{ Params: { runId: string } }>("/runs/:runId", async (req, reply) => {
    const run = getRun(db, req.params.runId);
    if (!run) return reply.status(404).send({ error: "Run not found" });
    return { run };
  });

  app.get<{ Params: { runId: string }; Querystring: { limit?: string; offset?: string; category?: string; since?: string } }>("/runs/:runId/events", async (req, reply) => {
    const run = getRun(db, req.params.runId);
    if (!run) return reply.status(404).send({ error: "Run not found" });
    const events = getEvents(db, req.params.runId, {
      limit: parseBoundedInt(req.query.limit, 200, 1, 1000),
      offset: parseBoundedInt(req.query.offset, 0, 0, 10_000_000),
      category: req.query.category,
      since: req.query.since,
    });
    return { events, total: countEvents(db, req.params.runId) };
  });

  app.post<{ Body: string }>("/events", async (req, reply) => {
    const body = req.body as string;
    if (!body) return reply.status(400).send({ error: "Empty body" });
    const lines = body.trim().split("\n").filter(Boolean);
    let inserted = 0;
    const errors: string[] = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as EngteamEvent;
        insertEvent(db, { runId: event.runId, ts: event.ts, category: event.category,
          type: event.type, step: event.step, agentName: event.agentName,
          summary: event.summary, payload: event.payload });
        inserted++;
      } catch (err) { errors.push(err instanceof Error ? err.message : String(err)); }
    }
    return { inserted, errors };
  });

  app.get("/stats", async () => {
    const runs = db.prepare("SELECT status, COUNT(*) as n FROM runs GROUP BY status").all();
    const eventCount = (db.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number }).n;
    return { runs, eventCount };
  });
}
