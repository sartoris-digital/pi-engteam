import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "../engine/state.js";
import { generatedMarker } from "../home.js";
import { fenceData } from "../safety/fence.js";

export { generatedMarker } from "../home.js";

export async function writeTextArtifact(
  runDir: string,
  relPath: string,
  body: string,
  mode = 0o600,
): Promise<string> {
  const path = join(runDir, relPath);
  const marker = generatedMarker(basename(runDir));
  const rest = body.startsWith(marker) ? body.slice(marker.length).replace(/^\n/, "") : body;
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${marker}\n${rest}`, mode);
  return path;
}

export async function ensureGeneratedMarker(path: string, runId: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const marker = generatedMarker(runId);
  if (text.startsWith(marker)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${marker}\n${text}`);
}

export async function readJsonArtifact<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeTicketMarkdown(runDir: string, text: string, nonce: string): Promise<string> {
  const fenced = fenceData(text, nonce, "TICKET");
  return writeTextArtifact(runDir, "ticket.md", `${fenced}\n`);
}
