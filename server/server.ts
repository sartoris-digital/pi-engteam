import Fastify, { FastifyInstance } from "fastify";
import { openDb } from "./storage.js";
import { registerRoutes } from "./routes.js";
import { EventWatcher } from "./watcher.js";
import type { ServerOptions } from "./types.js";

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const db = openDb(opts.dbPath);
  const watcher = new EventWatcher(opts.runsDir, db);

  registerRoutes(app, db, { ...opts, port: opts.port ?? 4747 });

  app.addHook("onReady", async () => { await watcher.start(); });
  app.addHook("onClose", async () => { watcher.stop(); });

  return app;
}
