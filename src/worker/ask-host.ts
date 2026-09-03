import { readFile } from "node:fs/promises";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { stageFactsPath } from "../controller/stage-facts.js";
import { stripMarker } from "../engine/state.js";

export const ASK_HOST_TOOL_NAME = "AskHost";

export const AskHostParams = Type.Object({
  key: Type.String({
    minLength: 1,
    description: 'Dotted fact key, e.g. "testDir", "writeRoots", "branching.base" or "rules"',
  }),
});
export type AskHostInput = Static<typeof AskHostParams>;

export interface AskHostOptions {
  runDir: string;
  /** Testability seam: override the facts reader. Default reads <runDir>/facts.json. */
  readFacts?: () => Promise<string>;
}

export interface AskHostDetails {
  key: string;
  found: boolean;
  /** Present only when the key was not found: every key the facts file does carry. */
  available?: string[];
}

/**
 * A missing or unreadable facts file is never an error: the agent is told to carry on and to
 * declare the assumption, which is strictly better than failing the turn over a lookup.
 */
const UNAVAILABLE =
  "Host facts are unavailable for this run. Proceed on your own judgment and state the assumption you made in your verdict.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every dotted path in the facts object, containers included. Arrays are leaves. */
export function factKeys(value: unknown, prefix = ""): string[] {
  if (!isPlainObject(value)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const path = prefix === "" ? k : `${prefix}.${k}`;
    out.push(path);
    out.push(...factKeys(v, path));
  }
  return out;
}

/** Dotted-path lookup over own enumerable properties only. undefined = no such fact. */
export function lookupFact(facts: unknown, key: string): unknown {
  const parts = key.split(".").filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  let cursor: unknown = facts;
  for (const part of parts) {
    if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, part)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

export function createAskHostTool(opts: AskHostOptions): ToolDefinition<typeof AskHostParams, AskHostDetails> {
  const read = opts.readFacts ?? (() => readFile(stageFactsPath(opts.runDir), "utf8"));
  return {
    name: ASK_HOST_TOOL_NAME,
    label: "Ask host",
    description:
      "Ask the host for a fact it already knows about this repo and run instead of inferring it: testDir, testPattern, writeRoots, branching.base, branching.target, checks, maxDiffLines, maxChangedFiles, lane, stage, kind, tier, ticketRef and the operator rules in scope. Read-only and synchronous — no human is involved and your turn does not pause. An unknown key comes back with the list of keys that exist, so a wrong guess costs one call. Decisions that genuinely need a person still go through RequestApproval and VerdictEmit NEEDS_MORE.",
    promptSnippet:
      "Ask the host for a repo/run fact (testDir, writeRoots, branching.base, checks, rules) rather than guessing at a convention",
    promptGuidelines: [
      "Never guess at a repo convention — the test directory, your write roots, the base branch, the checks or the diff caps. Call AskHost first; if it reports facts are unavailable, proceed and state the assumption in your verdict.",
    ],
    parameters: AskHostParams,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const key = typeof params.key === "string" ? params.key.trim() : "";
      const unavailable = {
        content: [{ type: "text" as const, text: UNAVAILABLE }],
        details: { key, found: false },
      };
      try {
        let facts: unknown;
        try {
          facts = JSON.parse(stripMarker(await read()));
        } catch {
          return unavailable;
        }
        if (!isPlainObject(facts)) return unavailable;
        const value = lookupFact(facts, key);
        if (value === undefined) {
          const available = factKeys(facts);
          return {
            content: [
              {
                type: "text" as const,
                text: `No host fact "${key}". Available keys: ${available.join(", ")}. Ask again with one of these.`,
              },
            ],
            details: { key, found: false, available },
          };
        }
        return {
          content: [{ type: "text" as const, text: `${key} = ${JSON.stringify(value)}` }],
          details: { key, found: true },
        };
      } catch {
        // execute never throws: a lookup must not be able to end a turn.
        return unavailable;
      }
    },
  };
}
