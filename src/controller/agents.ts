import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS } from "../lanes/catalog.js";
import type { AgentDef } from "../runtime/types.js";

const WRITERS = new Set(["implementer", "tester", "codifier"]);

/** Catalog minus `codifier`, which stays loadable on demand. */
export const V1_AGENTS = AGENTS.filter((name) => name !== "codifier");

export function packageRoot(fromMeta: string = import.meta.url): string {
  return join(dirname(fileURLToPath(fromMeta)), "..", "..");
}

export interface LoadAgentDefsOptions {
  root: string;
  models: Record<string, string>;
  defaultModel: string;
  required: readonly string[];
}

export async function loadAgentDefs(opts: LoadAgentDefsOptions): Promise<AgentDef[]> {
  const out: AgentDef[] = [];
  for (const name of opts.required) {
    const promptPath = join(opts.root, "agents", `${name}.md`);
    try {
      await readFile(promptPath, "utf8");
    } catch {
      throw new Error(`no agent definition for "${name}"`);
    }
    const writer = WRITERS.has(name);
    out.push({
      name,
      model: opts.models[name] ?? opts.defaultModel,
      promptPath,
      tools: writer
        ? ["read", "grep", "find", "write", "edit", "bash"]
        : ["read", "grep", "find"],
      stageClass: writer ? "writer" : "read-only",
    });
  }
  return out;
}
