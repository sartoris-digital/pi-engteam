import { readFile } from "node:fs/promises";
import type { OperatorOverlay, RepoDefaults, RepoEntry } from "../config/schema.js";
import type { SandboxProbe } from "../runtime/sandbox.js";
import type { ChecksProbe, DefaultBranchProbe, GitProbe, PackageManagerProbe } from "./probes.js";

export interface SetupUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, initial?: boolean): Promise<boolean | undefined>;
}

export interface SetupAnswers {
  coAuthoredBy?: boolean;
  maxLanes?: number;
  maxLanesPerRepo?: number;
  sandbox?: "required" | "best-effort" | "off";
  steering?: "always" | "elevated" | "never";
  planApproval?: "never" | "elevated" | "always";
  worktreeRoot?: string;
  remote?: string;
  tracker?: string;
  project?: string;
  label?: string;
}

export interface SetupDiff {
  operator?: OperatorOverlay;
  defaults?: RepoDefaults;
  repos?: RepoEntry[];
}

export interface InterviewResult {
  answers: SetupAnswers;
  diff: SetupDiff;
}

export async function readAnswersFile(path: string): Promise<SetupAnswers> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`setup answers: expected a JSON object in ${path}`);
  }
  return raw as SetupAnswers;
}

async function pick<T>(
  answers: SetupAnswers | undefined,
  key: keyof SetupAnswers,
  fallback: T,
  ask: () => Promise<T | undefined>,
): Promise<T> {
  const supplied = answers?.[key];
  if (supplied !== undefined && supplied !== "") return supplied as T;
  const asked = await ask();
  if (asked === undefined || asked === "") return fallback;
  return asked;
}

export async function runGlobalInterview(
  ui: SetupUi,
  opts: { probes: { sandbox: SandboxProbe }; answers?: SetupAnswers },
): Promise<InterviewResult> {
  const answers: SetupAnswers = { ...(opts.answers ?? {}) };
  answers.coAuthoredBy = await pick(opts.answers, "coAuthoredBy", true, () => ui.confirm("coAuthoredBy", true));
  answers.maxLanes = Number(
    await pick(opts.answers, "maxLanes", 3, async () => {
      const v = await ui.input("maxLanes", "3");
      return v === undefined ? 3 : Number(v);
    }),
  ) as SetupAnswers["maxLanes"];
  answers.maxLanesPerRepo = Number(
    await pick(opts.answers, "maxLanesPerRepo", 2, async () => {
      const v = await ui.input("maxLanesPerRepo", "2");
      return v === undefined ? 2 : Number(v);
    }),
  ) as SetupAnswers["maxLanesPerRepo"];
  answers.sandbox = await pick(opts.answers, "sandbox", "required", () =>
    ui.select(`sandbox (probe: ${opts.probes.sandbox.detail})`, ["required", "best-effort", "off"]),
  );
  answers.steering = await pick(opts.answers, "steering", "always", () =>
    ui.select("steering", ["always", "elevated", "never"]),
  );
  answers.planApproval = await pick(opts.answers, "planApproval", "never", () =>
    ui.select("planApproval", ["never", "elevated", "always"]),
  );
  const worktreeRoot = await pick(opts.answers, "worktreeRoot", "", () => ui.input("worktreeRoot"));
  if (typeof worktreeRoot === "string" && worktreeRoot.length > 0) answers.worktreeRoot = worktreeRoot;

  const operator: OperatorOverlay = {
    coAuthoredBy: answers.coAuthoredBy,
    maxLanes: answers.maxLanes,
    maxLanesPerRepo: answers.maxLanesPerRepo,
  };
  if (answers.worktreeRoot) operator.worktreeRoot = answers.worktreeRoot;
  const defaults: RepoDefaults = {
    sandbox: answers.sandbox,
    steering: answers.steering,
    planApproval: answers.planApproval,
  };
  return { answers, diff: { operator, defaults } };
}

export async function runRepoInterview(
  ui: SetupUi,
  repo: string,
  opts: {
    probes: {
      git: GitProbe;
      defaultBranch: DefaultBranchProbe;
      packageManager: PackageManagerProbe;
      checks: ChecksProbe;
    };
    answers?: SetupAnswers;
  },
): Promise<InterviewResult> {
  const answers: SetupAnswers = { ...(opts.answers ?? {}) };
  const origin = opts.probes.git.remotes.find((r) => r.name === "origin");
  answers.remote = await pick(opts.answers, "remote", origin?.name ?? "origin", () => ui.input("remote", "origin"));
  answers.tracker = await pick(opts.answers, "tracker", "local", () => ui.select("tracker", ["local"]));
  answers.project = await pick(opts.answers, "project", "local", () => ui.input("project", "local"));
  answers.label = await pick(opts.answers, "label", "factory:ready", () => ui.input("label", "factory:ready"));
  const repos: RepoEntry[] = [
    {
      path: repo,
      remote: answers.remote,
      tracker: answers.tracker,
      project: answers.project,
      label: answers.label,
    },
  ];
  return { answers, diff: { repos } };
}
