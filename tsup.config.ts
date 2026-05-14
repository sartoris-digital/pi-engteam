import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    splitting: false,
    // Pi loads extensions in an isolated context with no node_modules,
    // so bundle every runtime dep except the SDK Pi itself provides.
    noExternal: ["shell-quote", "@sinclair/typebox"],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ["@mariozechner/pi-coding-agent", "@mariozechner/pi-tui"],
  },
  {
    entry: { server: "server/index.ts" },
    // CJS avoids ESM/shebang issues when Node spawns the server as a child process.
    // fastify + the better-sqlite3 JS wrapper are bundled. The compiled .node binary
    // is sideloaded by server/index.ts via the `nativeBinding` option, so the
    // `require('bindings')` path inside better-sqlite3 is never executed.
    format: ["cjs"],
    target: "node20",
    bundle: true,
    splitting: false,
    dts: false,
    noExternal: ["fastify", "better-sqlite3"],
    outDir: "dist",
  },
]);
