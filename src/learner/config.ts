// src/learner/config.ts
// Loads ~/.pi/engineering-team/learner.json with defaults.
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export type LearnerMode = "queue-then-review" | "auto-on-completion" | "manual";

export type LearnerConfigFile = {
  mode: LearnerMode;
  autoOnCompletion: boolean;
};

export const DEFAULT_LEARNER_CONFIG: LearnerConfigFile = {
  mode: "queue-then-review",
  autoOnCompletion: false,
};

export async function loadLearnerConfig(
  path?: string,
): Promise<LearnerConfigFile> {
  const target = path ?? join(homedir(), ".pi", "engineering-team", "learner.json");
  try {
    const raw = await readFile(target, "utf8");
    const parsed = JSON.parse(raw) as Partial<LearnerConfigFile>;
    const mode = (parsed.mode ?? DEFAULT_LEARNER_CONFIG.mode) as LearnerMode;
    const validModes: LearnerMode[] = ["queue-then-review", "auto-on-completion", "manual"];
    return {
      mode: validModes.includes(mode) ? mode : DEFAULT_LEARNER_CONFIG.mode,
      autoOnCompletion: parsed.autoOnCompletion ?? DEFAULT_LEARNER_CONFIG.autoOnCompletion,
    };
  } catch {
    return { ...DEFAULT_LEARNER_CONFIG };
  }
}
