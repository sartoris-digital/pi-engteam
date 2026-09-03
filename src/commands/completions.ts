import { SUBCOMMANDS } from "./router.js";

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}
export interface CompletionRun {
  ref: string;
  runId: string;
  lane: string;
  status: string;
}
export interface CompletionDeps {
  lanes: string[];
  repos: string[];
  runs: CompletionRun[];
}

const VERB_HELP: Record<(typeof SUBCOMMANDS)[number], string> = {
  setup: "write global or repo factory.json",
  enqueue: "queue a local --task",
  start: "drain queued tickets",
  approve: "resume a waiting_user steer gate",
  status: "show queue / one run",
  landed: "mark a published ticket landed by the operator",
  closed: "mark a published ticket closed (retain worktree)",
  reconcile: "detect landings from git history",
};

const KINDS = ["feature", "enhancement", "bug", "chore"] as const;

function items(values: AutocompleteItem[], prefix: string): AutocompleteItem[] | null {
  const hit = values.filter((v) => v.value.startsWith(prefix) || v.value.split(/\s+/).pop()?.startsWith(prefix));
  return hit.length === 0 ? null : hit;
}

export function completeFactoryArgs(argumentPrefix: string, deps: CompletionDeps): AutocompleteItem[] | null {
  const trimmed = argumentPrefix;
  if (trimmed === "" || /^[a-z]*$/.test(trimmed)) {
    return items(
      SUBCOMMANDS.map((v) => ({ value: v, label: v, description: VERB_HELP[v] })),
      trimmed,
    );
  }
  if (trimmed.startsWith("enqueue --kind")) {
    const head = "enqueue --kind ";
    return items(
      KINDS.map((k) => ({ value: `${head}${k}`, label: k, description: k })),
      trimmed,
    );
  }
  if (trimmed.startsWith("enqueue --lane")) {
    return items(
      deps.lanes.map((l) => ({ value: `enqueue --lane ${l}`, label: l, description: l })),
      trimmed,
    );
  }
  if (trimmed.startsWith("enqueue --repo") || trimmed.startsWith("setup ")) {
    const verb = trimmed.startsWith("setup") ? "setup" : "enqueue --repo";
    return items(
      deps.repos.map((r) => ({ value: `${verb} ${r}`, label: r, description: r })),
      trimmed,
    );
  }
  if (
    trimmed.startsWith("approve") ||
    trimmed.startsWith("status") ||
    trimmed.startsWith("landed") ||
    trimmed.startsWith("closed")
  ) {
    const verb = trimmed.startsWith("approve")
      ? "approve"
      : trimmed.startsWith("status")
        ? "status"
        : trimmed.startsWith("landed")
          ? "landed"
          : "closed";
    return items(
      deps.runs.map((r) => ({
        value: `${verb} ${r.ref}`,
        label: r.ref,
        description: `${r.status} · ${r.lane}`,
      })),
      trimmed,
    );
  }
  return null;
}
