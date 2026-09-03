import { fileURLToPath } from "node:url";
import type { Kind } from "../config/schema.js";
import { KINDS } from "../config/schema.js";
import { createPathCli, type HostCli } from "../trackers/host-cli.js";

export interface SetFitEncoder {
  train(labels: { text: string; kind: Kind }[]): Promise<{ modelDir: string }>;
  infer(text: string): Promise<{ kind: Kind; score: number }>;
}

export interface CliTransport {
  exec(argv: string[], opts?: { input?: string }): Promise<{ code: number; stdout: string; stderr: string }>;
}

const DEFAULT_SCRIPT = fileURLToPath(new URL("./setfit-run.py", import.meta.url));

function isKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

function parseJson(stdout: string): unknown {
  const line = stdout.trim().split("\n").find((l) => l.startsWith("{") || l.startsWith("["));
  if (line === undefined) throw new Error("setfit: empty uv stdout");
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new Error(`setfit: invalid uv JSON: ${(err as Error).message}`);
  }
}

function asTransport(uv: CliTransport | HostCli): CliTransport {
  return {
    exec: (argv, opts) => uv.exec(argv, opts),
  };
}

class UvSetFitEncoder implements SetFitEncoder {
  constructor(
    private readonly uv: CliTransport,
    private readonly scriptPath: string,
    private readonly modelDir: string,
  ) {}

  private argv(command: "train" | "infer"): string[] {
    return ["uv", "run", "--script", "--offline", this.scriptPath, command, "--model-dir", this.modelDir];
  }

  private async run(command: "train" | "infer", payload: unknown): Promise<unknown> {
    const result = await this.uv.exec(this.argv(command), { input: JSON.stringify(payload) });
    if (result.code !== 0) {
      throw new Error(`setfit: uv ${command} exited ${result.code}: ${result.stderr}`.trim());
    }
    return parseJson(result.stdout);
  }

  async train(labels: { text: string; kind: Kind }[]): Promise<{ modelDir: string }> {
    const raw = await this.run("train", { labels });
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const dir = (raw as { modelDir?: unknown }).modelDir;
      if (typeof dir === "string" && dir.length > 0) return { modelDir: dir };
    }
    return { modelDir: this.modelDir };
  }

  async infer(text: string): Promise<{ kind: Kind; score: number }> {
    const raw = await this.run("infer", { text });
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("setfit: infer result is not an object");
    }
    const rec = raw as { kind?: unknown; score?: unknown };
    if (!isKind(rec.kind)) throw new Error("setfit: infer kind is not a ticket kind");
    const score = typeof rec.score === "number" && Number.isFinite(rec.score) ? rec.score : 0;
    return { kind: rec.kind, score };
  }
}

/** Production encoder shells out to `uv run --script --offline`. Tests inject `encoder`. */
export function createSetFit(opts: {
  encoder?: SetFitEncoder;
  uv?: CliTransport | HostCli;
  scriptPath?: string;
  modelDir?: string;
} = {}): SetFitEncoder {
  if (opts.encoder !== undefined) return opts.encoder;
  const uv = asTransport(opts.uv ?? createPathCli());
  return new UvSetFitEncoder(uv, opts.scriptPath ?? DEFAULT_SCRIPT, opts.modelDir ?? ".");
}
