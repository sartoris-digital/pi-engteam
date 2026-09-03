import { createHash } from "node:crypto";
import { canonicalJson } from "../config/json.js";
import type { StageDiff, StageExecution } from "./types.js";

const MONOREPO_ROOTS = new Set(["packages", "apps", "libs", "modules", "services"]);
const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const LOOKS_LIKE_PATH = /[\\/]|\.[A-Za-z][A-Za-z0-9]*$/;

function normalizePosix(posixPath: string): string {
  let s = posixPath.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  while (s.startsWith("/")) s = s.slice(1);
  return s;
}

function maskDigits(seg: string): string {
  return seg.replace(/\d+/g, "#");
}

function shapeSegment(seg: string, i: number, parts: string[]): string {
  if (i > 0 && MONOREPO_ROOTS.has(parts[i - 1] ?? "")) return "*";
  const isFile = i === parts.length - 1 && seg.includes(".");
  if (!isFile && SLUG.test(seg)) return "*";
  return maskDigits(seg);
}

/** Digits → `#`; kebab slug segments and monorepo package names → `*`. */
export function pathShape(posixPath: string): string {
  const norm = normalizePosix(posixPath);
  if (norm === "") return "";
  const parts = norm.split("/");
  return parts.map((seg, i) => shapeSegment(seg, i, parts)).join("/");
}

export function commandShape(argv: string[]): string {
  return argv
    .map((arg) => {
      if (LOOKS_LIKE_PATH.test(arg)) return pathShape(arg);
      return maskDigits(arg);
    })
    .join(" ");
}

function hunkBucket(n: number): string {
  if (n <= 8) return "8";
  if (n <= 32) return "32";
  if (n <= 64) return "64";
  return "xl";
}

export function diffShape(opts: {
  files: { path: string; op: "A" | "M" | "D"; hunkLines: number }[];
  literals: string[];
  sourced: string[];
}): string {
  const files = [...opts.files].sort((a, b) => a.path.localeCompare(b.path));
  const filePart = files.map((f) => `${f.op}:${pathShape(f.path)}:${hunkBucket(f.hunkLines)}`).join(" ");
  const sourced = new Set(opts.sourced);
  const litPart = [...opts.literals]
    .sort()
    .map((l) => (sourced.has(l) ? "$src" : maskDigits(l)))
    .join(",");
  return litPart === "" ? filePart : `${filePart};${litPart}`;
}

export function stageSignature(input: StageExecution): string {
  const paths = [...new Set(input.changedFiles.map((p) => pathShape(p)))].sort();
  const commands = input.commands.map((c) => commandShape(c.argv));
  const payload = {
    stage: input.stage,
    mode: input.mode ?? "",
    kind: input.kind,
    lane: input.lane,
    pathShape: paths.join(" "),
    commandShape: commands.join(" ; "),
    diffShape: diffShape(input.diff),
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export type { StageDiff };
