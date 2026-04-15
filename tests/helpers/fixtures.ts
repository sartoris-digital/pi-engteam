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
  "gh issue view 42 --json title,body,labels,state,assignees",
  "gh issue list --state open",
  "gh pr view 10",
  "az boards work-item show --id 99 --output json",
  "az boards work-item list --project MyProject",
  "jira issue view PROJ-123 --plain",
  "jira issue list",
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
  "gh issue create --title 'new bug'",
  "gh issue close 42",
  "az boards work-item create --title 'task'",
  "jira issue create",
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
