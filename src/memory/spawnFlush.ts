import { spawn } from "child_process";
import { access, constants, copyFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const SCRIPTS_DEST = join(homedir(), ".pi", "engteam", "second-brain", "scripts");
const SCRIPT_FILES = [
  "flush.mjs",
  "lib/config.mjs",
  "lib/logWriter.mjs",
  "lib/transcript.mjs",
] as const;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function getScriptsSrc(): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "..", "assets", "second-brain", "scripts"),
    join(moduleDir, "assets", "second-brain", "scripts"),
  ];

  for (const candidate of candidates) {
    if (await pathExists(join(candidate, "flush.mjs"))) {
      return candidate;
    }
  }

  throw new Error("Unable to locate bundled memory scripts");
}

export async function ensureScriptsInstalled(
  destDir: string = SCRIPTS_DEST,
  srcDir?: string,
): Promise<void> {
  const resolvedSrcDir = srcDir ?? await getScriptsSrc();

  await mkdir(join(destDir, "lib"), { recursive: true });

  for (const file of SCRIPT_FILES) {
    const dest = join(destDir, file);
    if (await pathExists(dest)) continue;
    await copyFile(join(resolvedSrcDir, file), dest);
  }
}

export function spawnFlush(snapshotPath: string, scriptsDir: string = SCRIPTS_DEST): void {
  const child = spawn(process.execPath, [join(scriptsDir, "flush.mjs"), snapshotPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
