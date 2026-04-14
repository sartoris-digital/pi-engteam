// src/safety/patterns.ts

export const DANGEROUS_RM_REGEXES: RegExp[] = [
  /rm\s+(-\w+\s+)*-[rf]{1,2}\s+(\/|~|~\/|\*|\.\/)(\s|$)/,
  /rm\s+(-\w+\s+)*-[rf]{1,2}\s+\$HOME/,
  /rm\s+(-\w+\s+)*-[rf]{1,2}\s+\.\.(\s|$)/,
];

export function isDangerousRm(command: string): boolean {
  return DANGEROUS_RM_REGEXES.some(r => r.test(command));
}

export const ENV_FILE_REGEX = /\.env(?!\.(?:sample|example))(\.[a-zA-Z0-9._-]+)?$/;

export function isEnvFileAccess(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? filePath;
  return ENV_FILE_REGEX.test(base);
}

export const FORCE_PUSH_REGEX = /git\s+push\s+.*(?:--force(?:-with-lease)?|-f)(?:\s|$)/;

export function isForcePush(command: string): boolean {
  return FORCE_PUSH_REGEX.test(command);
}

export const SUDO_REGEX = /^sudo\s|[;&|]\s*sudo\s/;

export function isSudo(command: string): boolean {
  return SUDO_REGEX.test(command);
}

export const PUBLISH_REGEX = /(?:npm|pnpm|yarn)\s+publish(?:\s|$)/;

export function isPublish(command: string): boolean {
  return PUBLISH_REGEX.test(command);
}

export const SHELL_INIT_REGEX = /(?:~\/\.(?:zshrc|bashrc|bash_profile|profile|zprofile)|\/etc\/profile)/;

export function isShellInitWrite(filePath: string): boolean {
  return SHELL_INIT_REGEX.test(filePath);
}

export const LAUNCHD_REGEX = /(?:launchctl\s+load|systemctl\s+enable|Library\/LaunchAgents|Library\/LaunchDaemons|\/etc\/systemd)/;

export function isLaunchdWrite(command: string): boolean {
  return LAUNCHD_REGEX.test(command);
}

export const DEVICE_WRITE_REGEX = /(?:dd\s+.*of=\/dev\/|mkfs\.|fdisk|diskutil\s+erase|parted)/;

export function isDeviceWrite(command: string): boolean {
  return DEVICE_WRITE_REGEX.test(command);
}
