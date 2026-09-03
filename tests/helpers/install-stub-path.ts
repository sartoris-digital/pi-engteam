import { chmod, copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPERS = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HELPERS, "fixtures");

export interface StubPathInstall {
  path: string;
  env: NodeJS.ProcessEnv;
}

async function copyJsonTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  let names: string[];
  try {
    names = await readdir(from);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of names) {
    await copyFile(join(from, name), join(to, name));
  }
}

async function writeWrapper(dest: string, script: string): Promise<void> {
  const body = `#!/usr/bin/env node
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ${JSON.stringify([script])}.concat(process.argv.slice(2)), {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
child.on("error", (err) => {
  process.stderr.write(String(err) + "\\n");
  process.exit(127);
});
`;
  await writeFile(dest, body, { encoding: "utf8", mode: 0o755 });
  await chmod(dest, 0o755);
}

/** Install stub `az`/`jira` onto `$home/bin` and copy fixtures into `$home/stub-fixtures`. */
export async function installStubPath(home: string): Promise<StubPathInstall> {
  const path = join(home, "bin");
  const stubDir = join(home, "stub-fixtures");
  await mkdir(path, { recursive: true, mode: 0o755 });
  await copyJsonTree(join(FIXTURES, "az"), join(stubDir, "az"));
  await copyJsonTree(join(FIXTURES, "jira"), join(stubDir, "jira"));
  await writeWrapper(join(path, "az"), join(HELPERS, "stub-az.mjs"));
  await writeWrapper(join(path, "jira"), join(HELPERS, "stub-jira.mjs"));
  return {
    path,
    env: {
      PATH: `${path}:${process.env.PATH ?? ""}`,
      PI_SDLC_STUB_DIR: stubDir,
      PI_SDLC_HOME: home,
    },
  };
}
