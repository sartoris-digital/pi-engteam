// Phase 5 §8 — Mental Models / Per-agent Expertise files.
//
// Two-layer expertise per agent:
//   user-global: ~/.pi/engineering-team/expertise/<agent>.md
//   project-local: <cwd>/.pi/engineering-team/expertise/<agent>.md
//
// Plus read-only domain knowledge files in
//   <cwd>/.pi/engineering-team/expertise/_readonly/*.md
// declared with frontmatter that names which agents see them.
//
// Single-writer policy: only Memory Core writes to expertise files. Agents
// emit wisdom via VerdictEmit; the curator (this module) dedupes and
// appends. _readonly/ files are user-authored and never modified here.

import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

// Phase 5 round-1 H3: expand a leading "~/" or bare "~" to homedir() so
// users following the spec's "~/.pi/engineering-team/expertise" example
// don't end up writing to a literal "~" directory.
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export type ExpertiseConfig = {
  enabled: boolean;
  maxLinesPerFile: number;
  promoteThresholdProjects: number;
  globalDir: string;
  projectDirSubpath: string;
};

export const DEFAULT_EXPERTISE_CONFIG: ExpertiseConfig = {
  enabled: true,
  maxLinesPerFile: 5000,
  promoteThresholdProjects: 3,
  globalDir: join(homedir(), ".pi", "engineering-team", "expertise"),
  projectDirSubpath: ".pi/engineering-team/expertise",
};

export type WisdomKind = "learning" | "decision" | "issue_found" | "gotcha";

export type WisdomEntry = {
  kind: WisdomKind;
  text: string;
};

export type ExpertiseDirs = {
  globalDir: string;
  projectDir: string;
};

export function resolveDirs(
  cfg: ExpertiseConfig,
  projectCwd: string,
): ExpertiseDirs {
  return {
    globalDir: expandTilde(cfg.globalDir),
    projectDir: join(projectCwd, cfg.projectDirSubpath),
  };
}

function expertiseFilePath(dir: string, agentName: string): string {
  // Disallow path traversal in agent names — accept only [A-Za-z0-9_-].
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(agentName)) {
    throw new Error(`Refusing expertise path for unsafe agent name: ${agentName}`);
  }
  return join(dir, `${agentName}.md`);
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Read user-global + project-local expertise for an agent, return rendered
 * `## Expertise` section text suitable for system prompt injection. Empty
 * when both files are missing/empty.
 */
export async function readExpertise(
  agentName: string,
  dirs: ExpertiseDirs,
): Promise<string> {
  const globalPath = expertiseFilePath(dirs.globalDir, agentName);
  const projectPath = expertiseFilePath(dirs.projectDir, agentName);
  const [globalRaw, projectRaw] = await Promise.all([
    readFileOrEmpty(globalPath),
    readFileOrEmpty(projectPath),
  ]);
  const sections: string[] = [];
  if (projectRaw.trim().length > 0) {
    sections.push("### From this project", projectRaw.trim());
  }
  if (globalRaw.trim().length > 0) {
    sections.push("### Global", globalRaw.trim());
  }
  if (sections.length === 0) return "";
  return ["## Expertise", "Curated from your prior runs across this project and globally.", ...sections, ""].join("\n");
}

type ReadonlyFrontmatter = {
  agents?: string[];
  /**
   * Round-1 M1: when an `agents:` key is present but its value cannot be
   * parsed (malformed YAML, missing brackets, etc.), we fail closed. This
   * flag tells the caller to exclude the file from ALL agents instead of
   * defaulting to "no agents key, all agents see it".
   */
  agentsMalformed?: boolean;
  loadOrder?: number;
};

function parseFrontmatter(raw: string): { meta: ReadonlyFrontmatter; body: string } {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: raw };
  const yaml = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, "");
  const meta: ReadonlyFrontmatter = {};
  for (const line of yaml.split("\n")) {
    // Round-2 M1: match the key first, value optional. An `agents:` line
    // with empty value previously fell through entirely (the prior regex
    // required `(.+)` after the colon) — silently treating "agents:" as
    // "no key" and projecting the file to all agents. Now an empty value
    // is detected and treated as malformed (fail-closed).
    const keyMatch = line.match(/^(\w+):\s*(.*)$/);
    if (!keyMatch) continue;
    const [, key, val] = keyMatch;
    if (key === "agents") {
      const trimmed = val.trim();
      if (trimmed.length === 0) {
        meta.agentsMalformed = true;
        meta.agents = [];
        continue;
      }
      const bracketMatch = trimmed.match(/^\[(.*)\]$/);
      if (!bracketMatch) {
        meta.agentsMalformed = true;
        meta.agents = [];
        continue;
      }
      const inner = bracketMatch[1].trim();
      const items = inner.length === 0
        ? []
        : inner
            .split(",")
            .map((s) => s.trim().replace(/^["']|["']$/g, ""))
            .filter((s) => s.length > 0);
      meta.agents = items;
    } else if (key === "loadOrder") {
      const n = parseInt(val.trim(), 10);
      if (Number.isFinite(n)) meta.loadOrder = n;
    }
  }
  return { meta, body };
}

/**
 * Read all `_readonly/*.md` files from project-local expertise dir and
 * return a rendered `## Read-only Knowledge` section for the given agent.
 * Files declare which agents see them via frontmatter `agents: [...]`.
 * No agents= entry means "all agents".
 */
export async function readReadonly(
  agentName: string,
  dirs: ExpertiseDirs,
): Promise<string> {
  const dir = join(dirs.projectDir, "_readonly");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return "";
  }
  const matching: Array<{ order: number; title: string; body: string }> = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    let raw: string;
    try {
      const st = await stat(path);
      if (!st.isFile()) continue;
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    // Round-1 M1: fail closed when the agents key is present but malformed,
    // OR when the parsed list is empty (treats `agents: []` as "no agents
    // see it" — a deliberate blacklist, not an oversight).
    if (meta.agentsMalformed) continue;
    if (Array.isArray(meta.agents) && meta.agents.length === 0 && raw.includes("agents:")) {
      continue;
    }
    if (Array.isArray(meta.agents) && meta.agents.length > 0 && !meta.agents.includes(agentName)) {
      continue;
    }
    const title = name.replace(/\.md$/, "");
    matching.push({ order: meta.loadOrder ?? 100, title, body: body.trim() });
  }
  if (matching.length === 0) return "";
  matching.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  const sections: string[] = ["## Read-only Knowledge"];
  for (const m of matching) {
    sections.push(m.body);
  }
  sections.push("");
  return sections.join("\n");
}

// Round-2 M2: per-entry text cap and per-batch item cap. Without these,
// a worker that floods VerdictEmit.learnings with megabytes of text could
// blow up future agent system prompts and memory snapshots.
const MAX_WISDOM_TEXT_CHARS = 500;
const MAX_WISDOM_ENTRIES_PER_BATCH = 50;

/**
 * Append new wisdom entries to project-local expertise file, dedupe
 * against existing content, enforce line cap (oldest entries pruned).
 * Returns the entries actually added (after dedup + length/count cap).
 */
export async function appendExpertise(
  agentName: string,
  dirs: ExpertiseDirs,
  entries: WisdomEntry[],
  cfg: ExpertiseConfig = DEFAULT_EXPERTISE_CONFIG,
): Promise<WisdomEntry[]> {
  if (!cfg.enabled || entries.length === 0) return [];
  // Cap incoming batch size — drop the tail rather than truncate prefix
  // so the earliest emitted wisdom wins on overflow.
  const limited = entries.slice(0, MAX_WISDOM_ENTRIES_PER_BATCH);
  await mkdir(dirs.projectDir, { recursive: true });
  const path = expertiseFilePath(dirs.projectDir, agentName);
  const existingRaw = await readFileOrEmpty(path);
  const existingLines = existingRaw.split("\n").map((l) => l.trim()).filter(Boolean);
  const existingSet = new Set(existingLines.map(stripBullet));
  const toAdd: WisdomEntry[] = [];
  for (const e of limited) {
    // Truncate per-entry text to keep prompt-injection blast radius bounded.
    const cappedText = e.text.length > MAX_WISDOM_TEXT_CHARS
      ? e.text.slice(0, MAX_WISDOM_TEXT_CHARS - 1) + "…"
      : e.text;
    const capped: WisdomEntry = { ...e, text: cappedText };
    const norm = stripBullet(capped.text).toLowerCase();
    if (norm.length === 0) continue;
    if (existingSet.has(norm)) continue;
    existingSet.add(norm);
    toAdd.push(capped);
  }
  if (toAdd.length === 0) return [];
  const newLines = toAdd.map((e) => formatBullet(e));
  const merged = [...existingLines, ...newLines];
  // Enforce file line cap by pruning oldest.
  const finalLines = merged.slice(Math.max(0, merged.length - cfg.maxLinesPerFile));
  await writeFile(path, finalLines.join("\n") + "\n");
  return toAdd;
}

function stripBullet(line: string): string {
  return line.replace(/^[-*]\s*\[\w+\]\s*/, "").replace(/^[-*]\s*/, "").trim().toLowerCase();
}

function formatBullet(e: WisdomEntry): string {
  return `- [${e.kind}] ${e.text.trim()}`;
}

/**
 * Track per-project occurrence of a wisdom entry. When the same normalized
 * line has been seen in N≥promoteThresholdProjects distinct project paths,
 * promote it to user-global.
 */
export async function trackAndMaybePromote(
  agentName: string,
  cfg: ExpertiseConfig,
  projectCwd: string,
  entries: WisdomEntry[],
): Promise<WisdomEntry[]> {
  if (!cfg.enabled || entries.length === 0) return [];
  // H3: honor ~ in globalDir consistently across read and write paths.
  const globalDir = expandTilde(cfg.globalDir);
  await mkdir(globalDir, { recursive: true });
  const countsPath = join(globalDir, ".counts.json");
  let counts: Record<string, Record<string, string[]>> = {};
  try {
    counts = JSON.parse(await readFile(countsPath, "utf8"));
  } catch {
    counts = {};
  }
  if (!counts[agentName]) counts[agentName] = {};
  const promoted: WisdomEntry[] = [];
  for (const e of entries) {
    const key = stripBullet(e.text);
    if (key.length === 0) continue;
    const projects = counts[agentName][key] ?? [];
    if (!projects.includes(projectCwd)) projects.push(projectCwd);
    counts[agentName][key] = projects;
    if (projects.length >= cfg.promoteThresholdProjects) {
      promoted.push(e);
    }
    // Allow user-marked promote tag in entry text.
    if (e.text.includes("[promote]")) {
      promoted.push({ ...e, text: e.text.replace(/\s*\[promote\]\s*/g, " ").trim() });
    }
  }
  await writeFile(countsPath, JSON.stringify(counts, null, 2));
  if (promoted.length === 0) return [];
  // Dedupe + append to global file.
  const globalDirs: ExpertiseDirs = { globalDir, projectDir: globalDir };
  await appendExpertise(agentName, globalDirs, promoted, cfg);
  return promoted;
}

export function verdictToWisdom(payload: {
  learnings?: string[];
  decisions?: string[];
  issues_found?: string[];
  gotchas?: string[];
}): WisdomEntry[] {
  const out: WisdomEntry[] = [];
  for (const text of payload.learnings ?? []) out.push({ kind: "learning", text });
  for (const text of payload.decisions ?? []) out.push({ kind: "decision", text });
  for (const text of payload.issues_found ?? []) out.push({ kind: "issue_found", text });
  for (const text of payload.gotchas ?? []) out.push({ kind: "gotcha", text });
  return out;
}
