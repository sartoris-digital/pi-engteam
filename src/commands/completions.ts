import { v3StatusCompletions } from "../v3/doctor.js";
import { CODIFIED_VERBS } from "./codified.js";
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
  waitingOn?: string;
  escalation?: string;
}
export interface CompletionDeps {
  lanes: string[];
  repos: string[];
  runs: CompletionRun[];
  secretNames?: string[];
  unboundNames?: string[];
  ruleIds?: string[];
  codifiedPromote?: string[];
}

const VERB_HELP: Record<(typeof SUBCOMMANDS)[number], string> = {
  setup: "write global or repo factory.json",
  config: "print the effective config",
  lanes: "print compiled lanes",
  rules: "list operator rules",
  remember: "store a durable operator rule",
  forget: "retire a remembered rule",
  secret: "set, list, rm, rotate, bind, export, import, or scrub vault secrets",
  grill: "enqueue a grill (pre-build) idea",
  watch: "path of a lane stream file",
  interrupt: "nudge a visible worker",
  start: "drain queued tickets / start the poller",
  stop: "stop the scheduler",
  status: "show queue / one run",
  doctor: "health probes and ledger metrics",
  enqueue: "queue a local --task or tracker ref",
  classify: "override kind and re-intake",
  resume: "resume a paused or failed run",
  approve: "resume an awaiting-steer gate",
  grant: "mint a once-scope approval token",
  replan: "steer re-plan with notes",
  cancel: "cancel a run and keep the worktree",
  drop: "cancel and remove an empty worktree",
  retry: "requeue an abandoned ticket",
  rescan: "drain the scheduler once",
  reconcile: "detect landings from git history",
  landed: "mark a published ticket landed by the operator",
  closed: "mark a published ticket closed (retain worktree)",
  gc: "remove old closed worktrees",
  rebase: "rebase a needs-rebase lane",
  codify: "mine or repair a codify candidate",
  codified: "list, explain, promote, or retire a codified tool",
};

const KINDS = ["feature", "enhancement", "bug", "chore"] as const;
const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
const SECRET_VERBS = ["set", "list", "rm", "rotate", "bind", "export", "import", "scrub"] as const;

function items(values: AutocompleteItem[], prefix: string): AutocompleteItem[] | null {
  const hit = values.filter((v) => v.value.startsWith(prefix) || v.value.split(/\s+/).pop()?.startsWith(prefix));
  return hit.length === 0 ? null : hit;
}

function isGrantable(run: CompletionRun): boolean {
  if (run.status === "approval-needed") return true;
  if (run.status === "blocked" && (run.waitingOn === "approval" || run.escalation === "approval-needed")) return true;
  return run.escalation === "approval-needed";
}

function isApprovable(run: CompletionRun): boolean {
  return run.status === "awaiting-steer";
}

function runItems(verb: string, runs: CompletionRun[], prefix: string): AutocompleteItem[] | null {
  return items(
    runs.map((r) => ({
      value: `${verb} ${r.ref}`,
      label: r.ref,
      description: `${r.status} · ${r.lane}`,
    })),
    prefix,
  );
}

export function completeFactoryArgs(argumentPrefix: string, deps: CompletionDeps): AutocompleteItem[] | null {
  const trimmed = argumentPrefix;
  if (trimmed.startsWith("setfit") || trimmed.startsWith("learner")) {
    return items(v3StatusCompletions(), trimmed);
  }
  if (trimmed === "" || /^[a-z]*$/.test(trimmed)) {
    return items(
      SUBCOMMANDS.map((v) => ({ value: v, label: v, description: VERB_HELP[v] })),
      trimmed,
    );
  }
  if (trimmed.startsWith("enqueue --kind")) {
    return items(
      KINDS.map((k) => ({ value: `enqueue --kind ${k}`, label: k, description: k })),
      trimmed,
    );
  }
  if (trimmed.startsWith("enqueue --lane") || trimmed.startsWith("remember --lane")) {
    const verb = trimmed.startsWith("remember") ? "remember --lane" : "enqueue --lane";
    return items(
      deps.lanes.map((l) => ({ value: `${verb} ${l}`, label: l, description: l })),
      trimmed,
    );
  }
  if (trimmed.startsWith("enqueue --priority")) {
    return items(
      PRIORITIES.map((p) => ({ value: `enqueue --priority ${p}`, label: p, description: p })),
      trimmed,
    );
  }
  if (
    trimmed.startsWith("enqueue --repo") ||
    trimmed.startsWith("setup ") ||
    trimmed.startsWith("config ") ||
    trimmed.startsWith("lanes ") ||
    trimmed.startsWith("remember --repo") ||
    trimmed.startsWith("rules --repo") ||
    trimmed.startsWith("forget --repo")
  ) {
    const verb = trimmed.startsWith("enqueue")
      ? "enqueue --repo"
      : trimmed.startsWith("remember")
        ? "remember --repo"
        : trimmed.startsWith("rules")
          ? "rules --repo"
          : trimmed.startsWith("forget")
            ? "forget --repo"
            : trimmed.startsWith("config")
              ? "config"
              : trimmed.startsWith("lanes")
                ? "lanes"
                : "setup";
    return items(
      deps.repos.map((r) => ({ value: `${verb} ${r}`, label: r, description: r })),
      trimmed,
    );
  }
  if (trimmed.startsWith("secret")) {
    const names = deps.secretNames ?? [];
    const after = trimmed.slice("secret".length);
    if (after === "" || after === " " || /^ [a-z]*$/.test(after)) {
      return items(
        SECRET_VERBS.map((v) => ({ value: `secret ${v}`, label: v, description: v })),
        trimmed,
      );
    }
    const match = /^ (set|rm|rotate)( |$)/.exec(after);
    if (match) {
      const verb = match[1]!;
      return items(
        names.map((n) => ({ value: `secret ${verb} ${n}`, label: n, description: n })),
        trimmed,
      );
    }
    const bind = /^ bind( |$)/.exec(after);
    if (bind) {
      const unbound = deps.unboundNames ?? [];
      return items(
        unbound.map((n) => ({ value: `secret bind ${n}`, label: n, description: n })),
        trimmed,
      );
    }
    return null;
  }
  if (trimmed.startsWith("codify")) {
    const after = trimmed.slice("codify".length);
    if (after === "" || after === " " || /^ -/.test(after) || /^ --[a-z]*$/.test(after)) {
      return items(
        [
          { value: "codify --scan", label: "--scan", description: "scan inbox for candidates" },
          { value: "codify --gaps", label: "--gaps", description: "scan verifier gaps" },
          { value: "codify --repair", label: "--repair", description: "enqueue a repair run" },
        ],
        trimmed,
      );
    }
    return null;
  }
  if (trimmed.startsWith("codified")) {
    const after = trimmed.slice("codified".length);
    if (after === "" || after === " " || /^ [a-z]*$/.test(after)) {
      return items(
        CODIFIED_VERBS.map((v) => ({ value: `codified ${v}`, label: v, description: v })),
        trimmed,
      );
    }
    const promote = /^ promote( |$)/.exec(after);
    if (promote) {
      const names = deps.codifiedPromote ?? [];
      return items(
        names.map((n) => ({ value: `codified promote ${n}`, label: n, description: n })),
        trimmed,
      );
    }
    return null;
  }
  if (trimmed.startsWith("approve")) {
    return runItems("approve", deps.runs.filter(isApprovable), trimmed);
  }
  if (trimmed.startsWith("grant")) {
    return runItems("grant", deps.runs.filter(isGrantable), trimmed);
  }
  if (trimmed.startsWith("watch")) {
    return runItems(
      "watch",
      deps.runs.filter((r) => r.status === "running"),
      trimmed,
    );
  }
  if (trimmed.startsWith("rebase")) {
    return runItems(
      "rebase",
      deps.runs.filter((r) => r.status === "needs-rebase"),
      trimmed,
    );
  }
  if (
    trimmed.startsWith("status") ||
    trimmed.startsWith("landed") ||
    trimmed.startsWith("closed") ||
    trimmed.startsWith("resume") ||
    trimmed.startsWith("cancel") ||
    trimmed.startsWith("drop") ||
    trimmed.startsWith("retry") ||
    trimmed.startsWith("replan") ||
    trimmed.startsWith("classify")
  ) {
    const verb = trimmed.split(/\s+/)[0]!;
    return runItems(verb, deps.runs, trimmed);
  }
  return null;
}
