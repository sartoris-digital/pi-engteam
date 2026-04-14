import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    splitting: false,
    dts: true,
    sourcemap: true,
    clean: true,
    external: ["@mariozechner/pi-coding-agent"],
  },
  {
    entry: { server: "server/index.ts" },
    format: ["esm"],
    target: "node20",
    bundle: true,
    splitting: false,
    dts: false,
    external: ["better-sqlite3"],
    outDir: "dist",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
