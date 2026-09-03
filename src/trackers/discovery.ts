import { DEFAULTS } from "../config/defaults.js";
import type { TrackerEntry } from "../config/schema.js";
import type { TrackerAdapter } from "./adapter.js";
import { GitHubAdapter, type GitHubAdapterOptions } from "./github.js";
import type { LocalAdapter } from "./local.js";

export type TrackerRegistry = Map<string, TrackerAdapter>;

const SCP = /^git@github\.com:([^/]+)\/(.+)$/i;
const URL =
  /^(?:https?:\/\/|ssh:\/\/(?:git@)?|git:\/\/)(?:www\.)?github\.com[/:]([^/]+)\/(.+)$/i;

export function detectTrackerFromRemote(url: string): { kind: "github"; owner: string; repo: string } | null {
  const raw = url.trim();
  const scp = SCP.exec(raw);
  const web = scp ?? URL.exec(raw);
  if (web === null) return null;
  const owner = web[1];
  let repo = web[2];
  if (owner === undefined || repo === undefined) return null;
  repo = repo.replace(/\/+$/, "").replace(/\.git$/i, "");
  const extra = repo.indexOf("/");
  if (extra !== -1) repo = repo.slice(0, extra);
  if (owner.length === 0 || repo.length === 0) return null;
  return { kind: "github", owner, repo };
}

export function githubConfigured(opts: { trackers?: TrackerEntry[]; remotes?: string[] }): boolean {
  if (opts.trackers?.some((t) => t.kind === "github") === true) return true;
  return (opts.remotes ?? []).some((remote) => detectTrackerFromRemote(remote) !== null);
}

export function buildTrackerRegistry(opts: {
  local: LocalAdapter;
  github?: GitHubAdapterOptions;
  trackers?: TrackerEntry[];
}): TrackerRegistry {
  const registry: TrackerRegistry = new Map();
  registry.set(opts.local.id, opts.local);
  if (opts.github === undefined) return registry;
  const entry = opts.trackers?.find((t) => t.kind === "github");
  registry.set(
    "github",
    new GitHubAdapter({
      ...opts.github,
      label: opts.github.label ?? entry?.label ?? DEFAULTS.trackerEntry.label,
      allowedLabelers: opts.github.allowedLabelers ?? entry?.allowedLabelers,
      ignoreAuthors: opts.github.ignoreAuthors ?? entry?.ignoreAuthors,
    }),
  );
  return registry;
}
