import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Brief } from "../../src/intake/brief-schema.js";
import type { TicketKind, TicketRef } from "../../src/trackers/adapter.js";
import { GitHubAdapter } from "../../src/trackers/github.js";
import { writeGlobalConfig } from "../../src/setup/writers.js";
import { makeFakeAnalyst, type FakeAnalystScript } from "./fake-analyst.js";
import { makeFixtureRepo, type FixtureRepo } from "./fixture-repo.js";
import { makeStubGh, type StubGhScript } from "./stub-gh.js";
import { makeTmpHome } from "./tmp-home.js";
import { writeFactoryTestConfig } from "../integration/harness.js";

const exec = promisify(execFile);

export const GITHUB_FIXTURE_REPO = "acme/widgets";
export const GITHUB_FIXTURE_ISSUE = 42;
export const GITHUB_FIXTURE_LABELER = "ada";

const ISSUE_BODY = [
  "Add a greeting helper in src/added.ts so the fixture app can greet callers by name",
  "without changing the existing add() behaviour.",
  "",
  "Acceptance: greet(\"factory\") returns \"hello factory\".",
].join("\n");

export function githubFixtureIssueBody(): string {
  return ISSUE_BODY;
}

export function githubFixtureChoreBrief(over: Partial<Brief> = {}): Brief {
  return {
    kind: "chore",
    flags: [],
    size: "S",
    reproSteps: "absent",
    acceptanceCriteria: [
      {
        id: "AC1",
        text: 'greet("factory") returns "hello factory"',
        source: "quoted",
        quote: 'greet("factory") returns "hello factory"',
      },
    ],
    likelyPaths: ["src/added.ts", "tests/added.test.ts"],
    questions: [],
    goal: "add a greeting helper",
    samples: { n: 2, kinds: ["chore"], acAgreement: 1 },
    prior: { kind: "chore", from: "title-prefix" },
    confidence: "HIGH",
    tier: "low",
    lane: "chore",
    ...over,
  };
}

export function githubFixtureBugBrief(over: Partial<Brief> = {}): Brief {
  return githubFixtureChoreBrief({
    kind: "bug",
    size: "M",
    reproSteps: "present",
    lane: "bug",
    prior: { kind: "bug", from: "title-prefix" },
    ...over,
  });
}

export interface GithubFactoryWorld {
  home: string;
  fixture: FixtureRepo;
  gh: StubGhScript;
  adapter: GitHubAdapter;
  analyst: ReturnType<typeof makeFakeAnalyst>;
  issueRef: TicketRef;
  cleanup: () => Promise<void>;
}

export interface GithubFactoryWorldOptions {
  kind?: TicketKind;
  steering?: "always" | "elevated" | "never";
  junitPath?: string;
}

function seedIssue(kind: TicketKind): StubGhScript {
  const title = kind === "chore" ? "chore: add a greeting helper" : "fix: greet callers by name";
  const key = `${GITHUB_FIXTURE_REPO}#${GITHUB_FIXTURE_ISSUE}`;
  return {
    authStatus: { code: 0, stdout: "logged in" },
    issues: {
      [key]: {
        number: GITHUB_FIXTURE_ISSUE,
        title,
        body: ISSUE_BODY,
        labels: ["factory:ready"],
        author: GITHUB_FIXTURE_LABELER,
        updatedAt: "2026-09-03T00:00:00.000Z",
        url: `https://github.com/${GITHUB_FIXTURE_REPO}/issues/${GITHUB_FIXTURE_ISSUE}`,
        state: "open",
      },
    },
    events: {
      [key]: [
        {
          event: "labeled",
          actor: { login: GITHUB_FIXTURE_LABELER },
          label: { name: "factory:ready" },
        },
      ],
    },
    collab: { [GITHUB_FIXTURE_LABELER]: { role_name: "write" } },
    comments: {},
    calls: [],
  };
}

function analystScript(kind: TicketKind): FakeAnalystScript {
  const brief = kind === "bug" ? githubFixtureBugBrief() : githubFixtureChoreBrief();
  return { A: brief, B: brief };
}

/** withTmpHome + fixture repo + stub gh issue #42 labelled factory:ready. */
export async function makeGithubFactoryWorld(
  opts: GithubFactoryWorldOptions = {},
): Promise<GithubFactoryWorld> {
  const kind = opts.kind ?? "chore";
  const tmp = await makeTmpHome();
  let fixture: FixtureRepo | undefined;
  try {
    fixture = await makeFixtureRepo();
    await writeFactoryTestConfig(tmp.home, fixture.repo, {
      steering: opts.steering ?? "never",
      junitPath: opts.junitPath ?? "reports/junit.xml",
    });
    await writeGlobalConfig(tmp.home, {
      operator: {
        trackers: [
          {
            id: "github",
            kind: "github",
            label: "factory:ready",
            allowedLabelers: [GITHUB_FIXTURE_LABELER],
          },
        ],
      },
      repos: [
        {
          path: fixture.repo,
          remote: fixture.bare,
          tracker: "github",
          project: GITHUB_FIXTURE_REPO,
          label: "factory:ready",
        },
      ],
    });
    await exec("git", ["-C", fixture.repo, "config", "user.name", "Fixture"]);
    await exec("git", ["-C", fixture.repo, "config", "user.email", "fixture@example.com"]);
    await exec("git", ["-C", fixture.repo, "config", "commit.gpgsign", "false"]);

    const gh = seedIssue(kind);
    const adapter = new GitHubAdapter({
      exec: makeStubGh(gh),
      repo: GITHUB_FIXTURE_REPO,
      label: "factory:ready",
      allowedLabelers: [GITHUB_FIXTURE_LABELER],
    });
    const analyst = makeFakeAnalyst(analystScript(kind));
    const issueRef: TicketRef = {
      tracker: "github",
      id: `${GITHUB_FIXTURE_REPO}#${GITHUB_FIXTURE_ISSUE}`,
    };

    let cleaned = false;
    const fx = fixture;
    return {
      home: tmp.home,
      fixture: fx,
      gh,
      adapter,
      analyst,
      issueRef,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await fx.cleanup();
        await tmp.cleanup();
      },
    };
  } catch (err) {
    await fixture?.cleanup().catch(() => undefined);
    await tmp.cleanup().catch(() => undefined);
    throw err;
  }
}
