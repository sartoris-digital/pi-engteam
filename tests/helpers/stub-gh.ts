import type { Comment, TicketSummary } from "../../src/trackers/adapter.js";
import { ensureRepoFlag, type GhExec, type GhResult } from "../../src/trackers/gh.js";

export interface StubGhIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  assignees?: string[];
  author: string;
  updatedAt: string;
  url: string;
  state: string;
}

export interface StubGhScript {
  authStatus?: { code: number; stdout: string; stderr?: string };
  issues?: Record<string, StubGhIssue>;
  events?: Record<string, Array<{ event: string; actor: { login: string }; label?: { name: string } }>>;
  collab?: Record<string, { role_name: string; permission?: string }>;
  comments?: Record<string, Comment[]>;
  search?: TicketSummary[];
  prs?: Array<{ head: string; number: number; url: string; state: string; mergeCommit?: string }>;
  calls?: string[][];
  nextCommentId?: number;
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith("-") ? v : undefined;
}

function repoOf(args: string[]): string | undefined {
  return flagValue(args, "--repo");
}

function positionalAfter(args: string[], verb: string): string | undefined {
  const i = args.indexOf(verb);
  if (i === -1) return undefined;
  for (let j = i + 1; j < args.length; j++) {
    const a = args[j];
    if (a === undefined) break;
    if (a.startsWith("-")) {
      if (
        a === "--repo" ||
        a === "--label" ||
        a === "--state" ||
        a === "--json" ||
        a === "--body" ||
        a === "--add-label" ||
        a === "--remove-label" ||
        a === "--add-assignee" ||
        a === "-X" ||
        a === "--method" ||
        a === "-f" ||
        a === "--raw-field"
      ) {
        j += 1;
      }
      continue;
    }
    return a;
  }
  return undefined;
}

function issueKey(repo: string, n: string | number): string {
  return `${repo}#${n}`;
}

function asGhIssue(issue: StubGhIssue): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map((name) => ({ name })),
    assignees: (issue.assignees ?? []).map((login) => ({ login })),
    author: { login: issue.author },
    updatedAt: issue.updatedAt,
    url: issue.url,
    state: issue.state,
  };
}

function jsonResult(value: unknown, code = 0): GhResult {
  return { stdout: `${JSON.stringify(value)}\n`, stderr: "", code };
}

function textResult(stdout: string, code = 0, stderr = ""): GhResult {
  return { stdout, stderr, code };
}

function dispatch(script: StubGhScript, args: string[]): GhResult {
  if (args[0] === "auth" && args[1] === "status") {
    const auth = script.authStatus ?? { code: 0, stdout: "logged in" };
    return { stdout: auth.stdout, stderr: auth.stderr ?? "", code: auth.code };
  }

  const repo = repoOf(args) ?? "";

  if (args[0] === "issue" && args[1] === "list") {
    const label = flagValue(args, "--label");
    const state = (flagValue(args, "--state") ?? "open").toLowerCase();
    const issues = Object.entries(script.issues ?? {})
      .filter(([key, issue]) => {
        if (repo && !key.startsWith(`${repo}#`)) return false;
        if (label !== undefined && !issue.labels.includes(label)) return false;
        if (state !== "all" && issue.state.toLowerCase() !== state) return false;
        return true;
      })
      .map(([, issue]) => asGhIssue(issue));
    return jsonResult(issues);
  }

  if (args[0] === "issue" && args[1] === "view") {
    const n = positionalAfter(args, "view");
    const issue = n !== undefined ? script.issues?.[issueKey(repo, n)] : undefined;
    if (!issue) return textResult("", 1, `issue ${n} not found`);
    return jsonResult(asGhIssue(issue));
  }

  if (args[0] === "issue" && args[1] === "comment") {
    const n = positionalAfter(args, "comment");
    const body = flagValue(args, "--body") ?? "";
    const key = issueKey(repo, n ?? "");
    const id = String(script.nextCommentId ?? ((script.comments?.[key]?.length ?? 0) + 1));
    script.nextCommentId = Number(id) + 1;
    const comment: Comment = {
      id,
      author: "factory",
      body,
      createdAt: "2026-09-03T00:00:00.000Z",
    };
    const list = script.comments?.[key] ?? [];
    list.push(comment);
    script.comments = { ...script.comments, [key]: list };
    return textResult(`https://github.com/${repo}/issues/${n}#issuecomment-${id}\n`);
  }

  if (args[0] === "issue" && args[1] === "edit") {
    const n = positionalAfter(args, "edit");
    const issue = n !== undefined ? script.issues?.[issueKey(repo, n)] : undefined;
    if (!issue) return textResult("", 1, `issue ${n} not found`);
    const add = flagValue(args, "--add-label");
    const remove = flagValue(args, "--remove-label");
    const assignee = flagValue(args, "--add-assignee");
    if (add !== undefined && !issue.labels.includes(add)) issue.labels.push(add);
    if (remove !== undefined) issue.labels = issue.labels.filter((l) => l !== remove);
    if (assignee !== undefined) {
      const current = issue.assignees ?? [];
      if (!current.includes(assignee)) current.push(assignee);
      issue.assignees = current;
    }
    return textResult("");
  }

  if (args[0] === "search" && args[1] === "issues") {
    if (script.search) return jsonResult(script.search);
    const q = positionalAfter(args, "issues") ?? "";
    const tokens = q.split(/\s+/).filter(Boolean);
    const hits = Object.entries(script.issues ?? {})
      .filter(([key, issue]) => {
        if (repo && !key.startsWith(`${repo}#`)) return false;
        const title = issue.title.toLowerCase();
        return tokens.every((t) => title.includes(t.toLowerCase()));
      })
      .map(([key, issue]) => ({
        ref: { tracker: "github" as const, id: key },
        title: issue.title,
        state: issue.state,
        updatedAt: issue.updatedAt,
        url: issue.url,
      }));
    return jsonResult(hits);
  }

  if (args[0] === "pr" && (args[1] === "list" || args[1] === "view")) {
    if (args[1] === "view") {
      const n = Number(positionalAfter(args, "view"));
      const pr = (script.prs ?? []).find((p) => p.number === n);
      if (!pr) return textResult("", 1, `pr ${n} not found`);
      return jsonResult({ state: pr.state, mergeCommit: pr.mergeCommit, url: pr.url, headRefName: pr.head, number: pr.number });
    }
    return jsonResult(script.prs ?? []);
  }

  if (args[0] === "api") {
    return dispatchApi(script, args, repo);
  }

  return textResult("", 1, `stub-gh: unhandled ${args.join(" ")}`);
}

function apiPath(args: string[]): string {
  return args.find((a, i) => i > 0 && !a.startsWith("-") && args[i - 1] !== "-X" && args[i - 1] !== "--method" && args[i - 1] !== "-f" && args[i - 1] !== "--raw-field" && args[i - 1] !== "--repo") ?? "";
}

function fieldValue(args: string[], name: string): string | undefined {
  for (const a of args) {
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
    if (a.startsWith(`-f${name}=`)) return a.slice(name.length + 3);
  }
  const f = args.indexOf("-f");
  if (f !== -1) {
    const pair = args[f + 1];
    if (pair?.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  const raw = args.indexOf("--raw-field");
  if (raw !== -1) {
    const pair = args[raw + 1];
    if (pair?.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return undefined;
}

function dispatchApi(script: StubGhScript, args: string[], repo: string): GhResult {
  const path = apiPath(args);
  const methodIdx = args.indexOf("-X") !== -1 ? args.indexOf("-X") : args.indexOf("--method");
  const method = (methodIdx !== -1 ? args[methodIdx + 1] : "GET")?.toUpperCase() ?? "GET";

  const eventsMatch = /^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/events$/.exec(path);
  if (eventsMatch) {
    const key = `${eventsMatch[1]}/${eventsMatch[2]}#${eventsMatch[3]}`;
    return jsonResult(script.events?.[key] ?? []);
  }

  const collabMatch = /^repos\/([^/]+)\/([^/]+)\/collaborators\/([^/]+)\/permission$/.exec(path);
  if (collabMatch) {
    const login = collabMatch[3] ?? "";
    const row = script.collab?.[login];
    if (!row) return textResult("", 1, "Not Found");
    return jsonResult({
      role_name: row.role_name,
      permission: row.permission ?? row.role_name,
      user: { login },
    });
  }

  const commentsMatch = /^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(path);
  if (commentsMatch) {
    const key = `${commentsMatch[1]}/${commentsMatch[2]}#${commentsMatch[3]}`;
    if (method === "POST") {
      const body = fieldValue(args, "body") ?? "";
      const id = String(script.nextCommentId ?? ((script.comments?.[key]?.length ?? 0) + 1));
      script.nextCommentId = Number(id) + 1;
      const comment: Comment = { id, author: "factory", body, createdAt: "2026-09-03T00:00:00.000Z" };
      const list = script.comments?.[key] ?? [];
      list.push(comment);
      script.comments = { ...script.comments, [key]: list };
      return jsonResult({ id: Number(id), user: { login: "factory" }, body, created_at: comment.createdAt });
    }
    const comments = (script.comments?.[key] ?? []).map((c) => ({
      id: Number(c.id) || c.id,
      user: { login: c.author },
      body: c.body,
      created_at: c.createdAt,
    }));
    return jsonResult(comments);
  }

  const commentMatch = /^repos\/([^/]+)\/([^/]+)\/issues\/comments\/([^/]+)$/.exec(path);
  if (commentMatch && method === "PATCH") {
    const id = commentMatch[3] ?? "";
    const body = fieldValue(args, "body") ?? "";
    for (const list of Object.values(script.comments ?? {})) {
      const found = list.find((c) => c.id === id);
      if (found) found.body = body;
    }
    return jsonResult({ id: Number(id) || id, body });
  }

  const reactionsMatch = /^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/reactions$/.exec(path);
  if (reactionsMatch) return jsonResult({ id: 1, content: fieldValue(args, "content") ?? "eyes" });

  void repo;
  return textResult("", 1, `stub-gh: unhandled api ${path}`);
}

export function makeStubGh(script: StubGhScript): GhExec {
  script.calls ??= [];
  return async (args, opts) => {
    const argv = opts?.repo ? ensureRepoFlag(args, opts.repo) : [...args];
    script.calls!.push(argv);
    return dispatch(script, argv);
  };
}
