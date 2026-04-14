import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export const SERVER_PORT = parseInt(
  process.env.PI_ENGTEAM_SERVER_PORT ?? "4747",
  10,
);

// Module-level singleton: null when no server has been started by this process
export let serverProcess: ReturnType<typeof spawn> | null = null;

/** Exposed for testing only — allows tests to inject a fake process. */
export function _setServerProcess(p: ReturnType<typeof spawn> | null): void {
  serverProcess = p;
}

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
  pi.registerCommand("observe", {
    description: "Start or stop the pi-engteam observability server. Usage: /observe [stop]",
    handler: async (args: string, _ctx) => {
      const stop = args.trim().toLowerCase() === "stop";
      if (stop) {
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
