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
    globalDir: cfg.globalDir,
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
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === "agents") {
      const arr = val.match(/\[(.*)\]/)?.[1] ?? "";
      meta.agents = arr
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0);
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

/**
 * Append new wisdom entries to project-local expertise file, dedupe
 * against existing content, enforce line cap (oldest entries pruned).
 * Returns the entries actually added (after dedup).
 */
export async function appendExpertise(
  agentName: string,
  dirs: ExpertiseDirs,
  entries: WisdomEntry[],
  cfg: ExpertiseConfig = DEFAULT_EXPERTISE_CONFIG,
): Promise<WisdomEntry[]> {
  if (!cfg.enabled || entries.length === 0) return [];
  await mkdir(dirs.projectDir, { recursive: true });
  const path = expertiseFilePath(dirs.projectDir, agentName);
  const existingRaw = await readFileOrEmpty(path);
  const existingLines = existingRaw.split("\n").map((l) => l.trim()).filter(Boolean);
  const existingSet = new Set(existingLines.map(stripBullet));
  const toAdd: WisdomEntry[] = [];
  for (const e of entries) {
    const norm = stripBullet(e.text).toLowerCase();
    if (norm.length === 0) continue;
    if (existingSet.has(norm)) continue;
    existingSet.add(norm);
    toAdd.push(e);
  }
  if (toAdd.length === 0) return [];
  const newLines = toAdd.map((e) => formatBullet(e));
  const merged = [...existingLines, ...newLines];
  // Enforce cap by pruning oldest.
  const capped = merged.slice(Math.max(0, merged.length - cfg.maxLinesPerFile));
  await writeFile(path, capped.join("\n") + "\n");
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
  await mkdir(cfg.globalDir, { recursive: true });
  const countsPath = join(cfg.globalDir, ".counts.json");
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
  const globalDirs: ExpertiseDirs = { globalDir: cfg.globalDir, projectDir: cfg.globalDir };
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
