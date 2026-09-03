// tests/helpers/load-extension.mjs — load a Pi TS extension into a fake ExtensionAPI.
//
// Used only when stub-pi sees PI_SDLC_STUB_LOAD_EXTENSION=1 and `-e <entry>`.
// Pi itself loads extensions with jiti; there is no build step in this package.
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";

export function findExtensionEntry(argv) {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "-e" || token === "--extension") {
      const next = argv[i + 1];
      return typeof next === "string" && next.length > 0 && !next.startsWith("-") ? next : null;
    }
    if (typeof token === "string" && token.startsWith("--extension=")) {
      const value = token.slice("--extension=".length);
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function createJitiLoader() {
  const req = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const jitiMod = req("jiti");
  const createJiti = jitiMod.createJiti ?? jitiMod;
  if (typeof createJiti !== "function") throw new Error("jiti.createJiti is not a function");
  return createJiti(import.meta.url, { interopDefault: true });
}

/** Minimal ExtensionAPI: registerWorker needs `on` + `registerTool`. */
export function createFakeExtensionAPI() {
  const handlers = new Map();
  const tools = [];
  const commands = new Map();
  return {
    handlers,
    tools,
    commands,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
  };
}

export async function loadAndActivate(entryPath, env = process.env) {
  const abs = isAbsolute(entryPath) ? entryPath : resolve(entryPath);
  const mod = await createJitiLoader().import(abs);
  const pi = createFakeExtensionAPI();
  if (typeof mod.selectMode === "function") {
    const mode = mod.selectMode(env);
    if (mode !== "worker") {
      throw new Error(`expected worker mode, got ${mode}; set PI_SDLC_AGENT_MODE=1 and a complete run context`);
    }
  }
  if (typeof mod.activate === "function") {
    await mod.activate(pi, env);
  } else if (typeof mod.default === "function") {
    await mod.default(pi);
  } else if (typeof mod.registerWorker === "function") {
    mod.registerWorker(pi, { env });
  } else {
    throw new Error(`extension ${abs} has no activate, default, or registerWorker export`);
  }
  return pi;
}

export async function fireToolCall(pi, toolName, input) {
  const event = { type: "tool_call", toolCallId: "stub-pi-guard", toolName, input };
  for (const handler of pi.handlers.get("tool_call") ?? []) {
    const result = await handler(event, {});
    if (result !== undefined && result !== null) return result;
  }
  return undefined;
}

export function assertGitPushTerminated(result) {
  if (result?.block !== true || result?.terminate !== true) {
    throw new Error(`git push must block with terminate:true, got ${JSON.stringify(result)}`);
  }
  const reason = typeof result.reason === "string" ? result.reason : "";
  if (!/^\[Layer A\].*git push is never allowed/.test(reason)) {
    throw new Error(`git push must be Layer A, got ${JSON.stringify(result)}`);
  }
}
