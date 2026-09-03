import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const PURPOSE_MAX = 240;
const WHEN_NOT_MAX = 5;

export interface SkillInput {
  name: string;
  type?: string;
  provenance?: string;
  description?: string;
}

export interface SkillManifest {
  name: string;
  version: number;
  class?: string;
  purpose: string;
  whenNot?: string[];
  inputs: SkillInput[];
  stage?: string;
  kind?: string;
  signature?: string;
  metadata?: Record<string, unknown>;
}

export function renderSkill(manifest: SkillManifest): string {
  if (manifest.purpose.length > PURPOSE_MAX) {
    throw new Error(`purpose exceeds ${PURPOSE_MAX} characters`);
  }
  const whenNot = manifest.whenNot ?? [];
  if (whenNot.length > WHEN_NOT_MAX) {
    throw new Error(`whenNot exceeds ${WHEN_NOT_MAX} entries`);
  }

  const lines: string[] = [
    "---",
    `name: ${manifest.name}`,
    `description: ${JSON.stringify(manifest.purpose)}`,
    "metadata:",
    "  pi-sdlc-factory-codified: true",
    "---",
    "",
    `# ${manifest.name}`,
    "",
    manifest.purpose,
    "",
  ];

  if (whenNot.length > 0) {
    lines.push("## When not to use", "");
    for (const item of whenNot) lines.push(`- ${item}`);
    lines.push("");
  }

  lines.push("## Inputs", "");
  if (manifest.inputs.length === 0) {
    lines.push("None.", "");
  } else {
    for (const inp of manifest.inputs) {
      const type = inp.type ? ` (${inp.type})` : "";
      const desc = inp.description ? `: ${inp.description}` : "";
      lines.push(`- \`${inp.name}\`${type}${desc}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function writeSkill(dir: string, manifest: SkillManifest): Promise<string> {
  const path = join(dir, "SKILL.md");
  await writeFile(path, renderSkill(manifest), "utf8");
  return path;
}
