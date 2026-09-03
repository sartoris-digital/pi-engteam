// src/git/pr.ts — injectable PR client. Production uses gh; tests inject a stub. Never merge.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeSlug } from "../workspace/git-provider.js";

export interface GhResult {
  stdout: string;
  stderr: string;
  code: number;
  headers?: Record<string, string>;
}

export type GhExec = (args: string[], opts?: { repo?: string }) => Promise<GhResult>;

export interface PrClient {
  create(opts: {
    repo: string;
    base: string;
    head: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<{ number: number; url: string }>;
}

export class GhPrError extends Error {
  constructor(readonly args: string[], readonly result: GhResult) {
    super(`gh ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`);
    this.name = "GhPrError";
  }
}

/** Host-sanitised title from branching.titleTemplate. Values are slugged; never raw model text. */
export function renderPrTitle(template: string, vars: Record<string, string>): string {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    try {
      safe[key] = key === "kind" || key === "ref" ? value : sanitizeSlug(value);
    } catch {
      safe[key] = "change";
    }
  }
  let out = template;
  for (const [key, value] of Object.entries(safe)) {
    out = out.replaceAll(`{{${key}}}`, value).replaceAll(`{${key}}`, value);
  }
  return out;
}

export function isDraftPr(opts: { tier: "low" | "elevated"; draftPolicy: "elevated" | "always" | "never" }): boolean {
  if (opts.draftPolicy === "always") return true;
  if (opts.draftPolicy === "never") return false;
  return opts.tier === "elevated";
}

function parsePrUrl(stdout: string): { number: number; url: string } {
  const url = stdout.trim().split(/\s+/).find((tok) => /\/pull\/\d+/.test(tok)) ?? stdout.trim();
  const m = url.match(/\/pull\/(\d+)/);
  if (m === null || m[1] === undefined) throw new Error(`gh pr create did not print a pull URL: ${stdout.trim()}`);
  return { number: Number(m[1]), url };
}

export function githubPrClient(exec: GhExec): PrClient {
  return {
    async create(opts) {
      const dir = await mkdtemp(join(tmpdir(), "factory-pr-body-"));
      const bodyFile = join(dir, "pr-body.md");
      try {
        await writeFile(bodyFile, opts.body, { encoding: "utf8" });
        const args = [
          "pr",
          "create",
          "--repo",
          opts.repo,
          "--base",
          opts.base,
          "--head",
          opts.head,
          "--title",
          opts.title,
          "--body-file",
          bodyFile,
        ];
        if (opts.draft) args.push("--draft");
        const result = await exec(args, { repo: opts.repo });
        if (result.code !== 0) throw new GhPrError(args, result);
        return parsePrUrl(result.stdout);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
