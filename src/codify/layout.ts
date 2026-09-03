import { join } from "node:path";

export function stagingDir(home: string, id: string): string {
  return join(home, "codified", ".staging", id);
}

export function sealedDir(home: string, name: string): string {
  return join(home, "codified", "_sealed", name);
}

export function toolDir(home: string, name: string): string {
  return join(home, "codified", "tools", name);
}

export function repoMirrorDir(repoRoot: string, name: string): string {
  return join(repoRoot, ".pi", "codified", name);
}

export function stagingFixturesDevDir(home: string, stagingId: string): string {
  return join(stagingDir(home, stagingId), "fixtures", "dev");
}

export function devFixtureDir(home: string, stagingId: string, index: number): string {
  return join(stagingFixturesDevDir(home, stagingId), String(index));
}

export function sealedFixtureDir(home: string, name: string, index: number): string {
  return join(sealedDir(home, name), String(index));
}
