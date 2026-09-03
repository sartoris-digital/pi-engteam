import { request as httpRequest, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";

const LOOPBACK = "127.0.0.1";
const DEFAULT_PORT = 443;

const WELL_KNOWN_PROVIDER_HOSTS = [
  { host: "api.anthropic.com", port: 443 },
  { host: "api.openai.com", port: 443 },
  { host: "generativelanguage.googleapis.com", port: 443 },
  { host: "openrouter.ai", port: 443 },
] as const;

export interface ProxyAllowlist {
  hosts: ReadonlyArray<{ host: string; port: number }>;
}

export interface EgressProxy {
  readonly url: string;
  readonly port: number;
  readonly allowlist: ProxyAllowlist;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Observer-shaped deny record. Hosts inject `onBlock` so this module does not import `src/observer`. */
export interface ProxyBlockEvent {
  category: "safety";
  type: "factory.safety.block";
  data: { host: string; port: number; method: string };
}

export interface CreateEgressProxyOptions {
  allowlist: ProxyAllowlist;
  listen?: { host?: string; port?: number };
  onBlock?: (event: ProxyBlockEvent) => void;
}

export function defaultProviderAllowlist(_providerKeyEnv?: string): ProxyAllowlist {
  return { hosts: WELL_KNOWN_PROVIDER_HOSTS.map((h) => ({ host: h.host, port: h.port })) };
}

function normalizeHosts(hosts: ProxyAllowlist["hosts"]): Array<{ host: string; port: number }> {
  return hosts.map((h) => ({
    host: h.host.toLowerCase(),
    port: h.port > 0 ? h.port : DEFAULT_PORT,
  }));
}

function isAllowed(hosts: ReadonlyArray<{ host: string; port: number }>, target: { host: string; port: number }): boolean {
  return hosts.some((h) => h.host === target.host && h.port === target.port);
}

function parseAuthority(raw: string, defaultPort: number): { host: string; port: number } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let host: string;
  let portRaw: string | undefined;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return null;
    host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    if (rest === "") portRaw = undefined;
    else if (rest.startsWith(":")) portRaw = rest.slice(1);
    else return null;
  } else {
    const colon = trimmed.lastIndexOf(":");
    if (colon === -1) {
      host = trimmed;
    } else {
      host = trimmed.slice(0, colon);
      portRaw = trimmed.slice(colon + 1);
    }
  }
  if (host.length === 0) return null;
  const port = portRaw === undefined || portRaw === "" ? defaultPort : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: host.toLowerCase(), port };
}

function targetFromHttp(req: IncomingMessage): { host: string; port: number } | null {
  const url = req.url ?? "";
  if (/^https:\/\//i.test(url)) return null;
  if (/^http:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      const port = parsed.port === "" ? 80 : Number(parsed.port);
      if (parsed.hostname.length === 0 || !Number.isInteger(port)) return null;
      return { host: parsed.hostname.toLowerCase(), port };
    } catch {
      return null;
    }
  }
  const header = req.headers.host;
  if (typeof header !== "string") return null;
  return parseAuthority(header, DEFAULT_PORT);
}

function originPath(req: IncomingMessage): string {
  const url = req.url ?? "/";
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}` || "/";
    } catch {
      return "/";
    }
  }
  return url.length > 0 ? url : "/";
}

export function createEgressProxy(opts: CreateEgressProxyOptions): EgressProxy {
  const listenHost = opts.listen?.host ?? LOOPBACK;
  if (listenHost !== LOOPBACK) throw new Error("proxy: listen host must be 127.0.0.1");

  const hosts = normalizeHosts(opts.allowlist.hosts);
  const allowlist: ProxyAllowlist = { hosts };
  const sockets = new Set<{ destroy: () => void }>();
  const server = createServer();
  let boundPort = opts.listen?.port ?? 0;

  const track = (socket: { destroy: () => void; on: (event: "close", fn: () => void) => void }): void => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };

  const emitBlock = (method: string, target: { host: string; port: number }): void => {
    opts.onBlock?.({
      category: "safety",
      type: "factory.safety.block",
      data: { host: target.host, port: target.port, method },
    });
  };

  const denyConnect = (
    socket: { writable: boolean; end: (data?: string) => void; destroy: () => void },
    method: string,
    target: { host: string; port: number } | null,
  ): void => {
    if (target !== null) emitBlock(method, target);
    if (socket.writable) socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  };

  server.on("connection", (socket) => track(socket));

  server.on("connect", (req, socket, head) => {
    track(socket);
    const target = parseAuthority(req.url ?? "", DEFAULT_PORT);
    if (target === null || !isAllowed(hosts, target)) {
      denyConnect(socket, "CONNECT", target);
      return;
    }
    const dest = netConnect({ host: target.host, port: target.port, family: 4 });
    track(dest);
    const timer = setTimeout(() => dest.destroy(), 5_000);
    dest.once("connect", () => {
      clearTimeout(timer);
      if (!socket.writable) {
        dest.destroy();
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) dest.write(head);
      socket.pipe(dest);
      dest.pipe(socket);
    });
    dest.on("error", () => {
      clearTimeout(timer);
      if (socket.writable) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      else socket.destroy();
    });
    socket.on("error", () => dest.destroy());
    socket.on("close", () => dest.destroy());
  });

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const target = targetFromHttp(req);
    if (target === null || !isAllowed(hosts, target)) {
      if (target !== null) emitBlock(method, target);
      res.writeHead(403, { Connection: "close", "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["proxy-connection"];
    delete headers["keep-alive"];
    delete headers["transfer-encoding"];
    delete headers.upgrade;
    const upstream = httpRequest(
      { host: target.host, port: target.port, method, path: originPath(req), headers, family: 4 },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    track(upstream);
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { Connection: "close" });
      res.end();
    });
    req.pipe(upstream);
  });

  return {
    allowlist,
    get port() {
      return boundPort;
    },
    get url() {
      return `http://${LOOPBACK}:${boundPort}`;
    },
    async start() {
      if (server.listening) return;
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen(opts.listen?.port ?? 0, LOOPBACK, () => {
          server.off("error", onError);
          const addr = server.address();
          if (addr === null || typeof addr === "string") {
            reject(new Error("proxy: failed to bind 127.0.0.1"));
            return;
          }
          boundPort = addr.port;
          resolve();
        });
      });
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
