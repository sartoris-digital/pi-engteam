export type ConfigErrorCode = "parse" | "version" | "unknown-key" | "schema" | "narrowing" | "deleted-default";

/** Every configuration failure is a ConfigError; `code` says which rule fired, `keyPath` names the offending key. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly keyPath: string | undefined;
  readonly file: string | undefined;

  constructor(code: ConfigErrorCode, message: string, extra: { keyPath?: string; file?: string } = {}) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.keyPath = extra.keyPath;
    this.file = extra.file;
  }
}
