import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { generatedMarker } from "./marker.js";

const STAGE_NAME = /^[a-z0-9][a-z0-9-]*$/i;

export function requiredFinalAction(stage: string): string {
  return `REQUIRED FINAL ACTION: call VerdictEmit with step="${stage}"`;
}

export function stepPromptPath(runDir: string, stage: string, round: number): string {
  return join(runDir, "steps", `${stage}-r${round}.prompt.md`);
}

/** The only prompt text that travels through argv: a pointer to the prompt file. */
export function promptPointer(promptPath: string): string {
  return `Read ${promptPath} and execute it. Finish by calling VerdictEmit.`;
}

export async function writeStepPrompt(runDir: string, stage: string, text: string, round = 1): Promise<string> {
  if (!STAGE_NAME.test(stage)) throw new Error(`writeStepPrompt: invalid stage name "${stage}"`);
  const marker = generatedMarker(basename(runDir));
  const body = text.startsWith(marker) ? text.slice(marker.length).replace(/^\n/, "") : text;
  const trimmed = body.replace(/\s+$/, "");
  const sentence = requiredFinalAction(stage);
  const full = trimmed.includes(sentence) ? `${marker}\n${trimmed}\n` : `${marker}\n${trimmed}\n\n${sentence}\n`;
  const path = stepPromptPath(runDir, stage, round);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, full, "utf8");
  return path;
}
