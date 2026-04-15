import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";

export type ActiveRunState = {
  runId: string;
  phase: "answering" | "approving";
  stepName: string;
  runsDir: string;
};

function activeRunPath(): string {
  return join(process.cwd(), ".pi", "engteam", "active-run.json");
}

export async function writeActiveRun(state: ActiveRunState): Promise<void> {
  const dir = join(process.cwd(), ".pi", "engteam");
  await mkdir(dir, { recursive: true });
  await writeFile(activeRunPath(), JSON.stringify(state, null, 2));
}

export async function readActiveRun(): Promise<ActiveRunState | null> {
  try {
    const raw = await readFile(activeRunPath(), "utf8");
    return JSON.parse(raw) as ActiveRunState;
  } catch {
    return null;
  }
}

export async function clearActiveRun(): Promise<void> {
  try {
    await unlink(activeRunPath());
  } catch {
    // file may not exist — that is fine
  }
}
