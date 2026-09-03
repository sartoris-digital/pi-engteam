import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import {
  connect as netConnect,
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEgressProxy,
  defaultProviderAllowlist,
  type EgressProxy,
  type ProxyBlockEvent,
} from "../../../src/runtime/proxy.js";

const LOOPBACK = "127.0.0.1";

const closers: Array<() => Promise<void>> = [];
const proxies: EgressProxy[] = [];

afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.stop();
  for (const close of closers.splice(0)) await close();
});

function track<T extends EgressProxy>(proxy: T): T {
  proxies.push(proxy);
  return proxy;
}

async function closeServer(server: NetServer | import("node:http").Server, sockets: Iterable<Socket> = []): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function listenEcho(): Promise<{ port: number; hits: () => number }> {
  const sockets = new Set<Socket>();
  let hits = 0;
  const server = createNetServer((socket) => {
    hits += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.pipe(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  closers.push(() => closeServer(server, sockets));
  return { port: addr.port, hits: () => hits };
}

async function listenHttp(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ port: number }> {
  const sockets = new Set<Socket>();
  const server = createHttpServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  closers.push(() => closeServer(server, sockets));
  return { port: addr.port };
}

function sendConnect(
  proxyPort: number,
  target: string,
): Promise<{ status: number; socket: Socket; statusLine: string }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: LOOPBACK, port: proxyPort });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`CONNECT ${target} timed out`));
    }, 2_000);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once("connect", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      socket.off("data", onData);
      clearTimeout(timer);
      const header = buf.subarray(0, idx).toString("latin1");
      const statusLine = header.split("\r\n")[0] ?? "";
      const match = /^HTTP\/1\.[01] (\d+)/.exec(statusLine);
      const rest = buf.subarray(idx + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve({ status: match ? Number(match[1]) : 0, socket, statusLine });
    };
    socket.on("data", onData);
  });
}

function proxyGet(proxyPort: number, hostHeader: string, path = "/"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: LOOPBACK, port: proxyPort, method: "GET", path, headers: { Host: hostHeader } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.setTimeout(2_000, () => {
      req.destroy(new Error("GET timed out"));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("defaultProviderAllowlist", () => {
  it("includes the well-known provider hosts on port 443", () => {
    expect(defaultProviderAllowlist().hosts).toEqual([
      { host: "api.anthropic.com", port: 443 },
      { host: "api.openai.com", port: 443 },
      { host: "generativelanguage.googleapis.com", port: 443 },
      { host: "openrouter.ai", port: 443 },
    ]);
  });

  it("still returns those four hosts for an unknown providerKeyEnv", () => {
    expect(defaultProviderAllowlist("UNKNOWN_KEY").hosts).toEqual(defaultProviderAllowlist().hosts);
    expect(defaultProviderAllowlist("ANTHROPIC_API_KEY").hosts).toEqual(
      expect.arrayContaining([{ host: "api.anthropic.com", port: 443 }]),
    );
  });
});

describe("createEgressProxy", () => {
  it("throws when asked to bind 0.0.0.0", () => {
    expect(() => createEgressProxy({ allowlist: { hosts: [] }, listen: { host: "0.0.0.0" } })).toThrow(/127\.0\.0\.1/);
  });

  it("listens only on 127.0.0.1 with an ephemeral port", async () => {
    const proxy = track(createEgressProxy({ allowlist: { hosts: [] } }));
    await proxy.start();
    expect(proxy.port).toBeGreaterThan(0);
    expect(proxy.url).toBe(`http://${LOOPBACK}:${proxy.port}`);
    const addr = await new Promise<AddressInfo>((resolve, reject) => {
      const socket = netConnect({ host: LOOPBACK, port: proxy.port });
      socket.once("error", reject);
      socket.once("connect", () => {
        const local = socket.address();
        socket.destroy();
        if (local && typeof local === "object" && "address" in local && typeof local.address === "string") {
          resolve(local);
        } else {
          reject(new Error("expected AddressInfo"));
        }
      });
    });
    expect(addr.address).toBe(LOOPBACK);
  });

  it("CONNECT-tunnels an allowlisted loopback echo and 403s any other local port", async () => {
    const echo = await listenEcho();
    const other = await listenEcho();
    const blocks: ProxyBlockEvent[] = [];
    const proxy = track(
      createEgressProxy({
        allowlist: { hosts: [{ host: LOOPBACK, port: echo.port }] },
        onBlock: (event) => blocks.push(event),
      }),
    );
    await proxy.start();

    const allowed = await sendConnect(proxy.port, `${LOOPBACK}:${echo.port}`);
    expect(allowed.statusLine.startsWith("HTTP/1.1 200")).toBe(true);
    expect(allowed.status).toBe(200);
    const reply = await new Promise<string>((resolve, reject) => {
      allowed.socket.once("error", reject);
      allowed.socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
      allowed.socket.write("ping");
    });
    expect(reply).toBe("ping");
    allowed.socket.destroy();
    expect(echo.hits()).toBe(1);

    const denied = await sendConnect(proxy.port, `${LOOPBACK}:${other.port}`);
    expect(denied.status).toBe(403);
    expect(denied.statusLine).toBe("HTTP/1.1 403 Forbidden");
    denied.socket.destroy();
    expect(other.hits()).toBe(0);
    expect(blocks).toEqual([
      {
        category: "safety",
        type: "factory.safety.block",
        data: { host: LOOPBACK, port: other.port, method: "CONNECT" },
      },
    ]);
  });

  it("filters plain HTTP GET by Host against the same allowlist", async () => {
    const origin = await listenHttp((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    const other = await listenHttp((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("nope");
    });
    const blocks: ProxyBlockEvent[] = [];
    const proxy = track(
      createEgressProxy({
        allowlist: { hosts: [{ host: LOOPBACK, port: origin.port }] },
        onBlock: (event) => blocks.push(event),
      }),
    );
    await proxy.start();

    const allowed = await proxyGet(proxy.port, `${LOOPBACK}:${origin.port}`, `http://${LOOPBACK}:${origin.port}/hello`);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toBe("ok");

    const denied = await proxyGet(proxy.port, `${LOOPBACK}:${other.port}`, "/");
    expect(denied.status).toBe(403);
    expect(denied.body).not.toBe("nope");
    expect(blocks).toEqual([
      {
        category: "safety",
        type: "factory.safety.block",
        data: { host: LOOPBACK, port: other.port, method: "GET" },
      },
    ]);
  });

  it("stop() closes the listener and destroys open tunnels", async () => {
    const echo = await listenEcho();
    const proxy = track(
      createEgressProxy({ allowlist: { hosts: [{ host: LOOPBACK, port: echo.port }] } }),
    );
    await proxy.start();
    const { status, socket } = await sendConnect(proxy.port, `${LOOPBACK}:${echo.port}`);
    expect(status).toBe(200);
    await proxy.stop();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("tunnel stayed open")), 2_000);
      socket.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.write("x");
    });
    await expect(
      new Promise<void>((resolve, reject) => {
        const next = netConnect({ host: LOOPBACK, port: proxy.port });
        next.once("connect", () => {
          next.destroy();
          reject(new Error("listener still accepting"));
        });
        next.once("error", () => resolve());
      }),
    ).resolves.toBeUndefined();
  });
});
