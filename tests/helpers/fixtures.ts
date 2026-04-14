import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync } from "fs";
import { mkdir } from "fs/promises";

export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-engteam-test-"));
}

export async function makeTmpDirAsync(): Promise<string> {
  const dir = join(tmpdir(), `pi-engteam-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export const SAFE_COMMANDS = [
  "cat README.md",
  "grep -r 'foo' src/",
  "ls -la",
  "git status",
  "git diff HEAD",
  "find . -name '*.ts' -not -path '*/node_modules/*'",
  "wc -l src/index.ts",
  "jq '.version' package.json",
  "pnpm test",
  "vitest run",
  "tsc --noEmit",
];

export const DESTRUCTIVE_COMMANDS = [
  "rm -f old.txt",
  "mv src/old.ts src/new.ts",
  "npm install lodash",
  "git commit -m 'feat: add stuff'",
  "sed -i 's/foo/bar/g' file.txt",
  "git push origin main",
  "chmod +x script.sh",
  "kill -9 12345",
];

export const BLOCKED_COMMANDS = [
  "rm -rf /",
  "rm -rf ~",
  "sudo apt install vim",
  "cat ~/.env",
  "cat .env",
  "git push --force origin main",
  "npm publish",
  "chmod 777 /usr/local/bin/foo",
  "dd if=/dev/zero of=/dev/sda",
];
