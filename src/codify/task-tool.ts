import type { SandboxProfile } from "../runtime/sandbox.js";
import { PROTECTED_READ_DENY, HERDR_SOCKET } from "../runtime/sandbox.js";
import type { CodifyConfig } from "../config/schema.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Manifest, ToolClass } from "./types.js";

export interface EffectOp {
  op: string;
  target: string;
  [key: string]: unknown;
}

export interface EffectPlan {
  dryRun: true;
  effects: EffectOp[];
}

/** Machine-readable contract for `--dry-run` stdout. */
export const EFFECT_PLAN_SCHEMA = {
  type: "object",
  required: ["dryRun", "effects"],
  properties: {
    dryRun: { const: true },
    effects: {
      type: "array",
      items: {
        type: "object",
        required: ["op", "target"],
        properties: {
          op: { type: "string" },
          target: { type: "string" },
        },
      },
    },
  },
} as const;

export type SupervisedState = "assist" | "supervised-1" | "supervised-2" | "active";
export type SupervisedOutcome = "success" | "fail" | "out-of-plan";

export type TaskToolProfile = SandboxProfile & { networkAllow?: string[] };

function jsonLines(stdout: string): unknown[] {
  const out: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed) as unknown);
    } catch {
      /* skip non-JSON */
    }
  }
  if (out.length === 0) {
    try {
      out.push(JSON.parse(stdout) as unknown);
    } catch {
      /* whole blob is not JSON */
    }
  }
  return out;
}

function isEffectPlan(value: unknown): value is EffectPlan {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as { dryRun?: unknown; effects?: unknown };
  if (rec.dryRun !== true) return false;
  if (!Array.isArray(rec.effects)) return false;
  return rec.effects.every((e) => {
    if (typeof e !== "object" || e === null) return false;
    const op = e as { op?: unknown; target?: unknown };
    return typeof op.op === "string" && typeof op.target === "string";
  });
}

export function parseEffectPlan(stdout: string): EffectPlan {
  for (const candidate of jsonLines(stdout)) {
    if (isEffectPlan(candidate)) return candidate;
    if (typeof candidate === "object" && candidate !== null && "dryRun" in candidate) {
      throw new Error("effect plan: dryRun must be true");
    }
  }
  throw new Error("effect plan: no JSON line with dryRun: true");
}

function substitute(template: string, inputs: Record<string, string>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, name: string) => inputs[name] ?? _whole);
}

export function taskToolProfile(
  manifest: Manifest,
  ws: { workspaceDir: string; runDir: string },
  inputs: Record<string, string> = {},
): TaskToolProfile {
  const allow = (manifest.network?.allow ?? []).map((host) => substitute(host, inputs));
  const allowWrite = manifest.sideEffects.writesWorkspace ? [ws.workspaceDir, ws.runDir] : [ws.runDir];
  const home = homedir();
  return {
    workspaceDir: ws.workspaceDir,
    runDir: ws.runDir,
    allowWrite,
    denyRead: PROTECTED_READ_DENY.map((rel) => (rel.startsWith("/") ? rel : join(home, rel))),
    denyUnixSockets: [join(home, HERDR_SOCKET)],
    network: "deny",
    networkAllow: allow,
  };
}

export function nextSupervised(state: SupervisedState, outcome: SupervisedOutcome): SupervisedState | "retired" {
  if (outcome === "out-of-plan") return "retired";
  if (outcome === "fail") return state;
  if (state === "assist") return "supervised-1";
  if (state === "supervised-1") return "supervised-2";
  if (state === "supervised-2") return "active";
  return "active";
}

export function unattendedAllowed(cfg: CodifyConfig, class_: ToolClass): boolean {
  if (class_ !== "task-tool") return true;
  return cfg.taskTools.unattended === "always";
}

const URL_LITERAL = /https?:\/\/([^/\s"'`]+)/gi;

export function lintTaskToolNetwork(
  source: string,
  allow: string[],
): { ok: true } | { ok: false; host: string } {
  const allowed = new Set(allow.map((h) => h.toLowerCase()));
  const copy = new RegExp(URL_LITERAL.source, URL_LITERAL.flags);
  let match: RegExpExecArray | null;
  while ((match = copy.exec(source)) !== null) {
    const host = (match[1] ?? "").split(":")[0]?.toLowerCase() ?? "";
    if (host.length === 0) continue;
    if (!allowed.has(host)) return { ok: false, host };
  }
  return { ok: true };
}
