import { defineConfig } from "tsup";

// esbuild walks every conditional branch when bundling — including the
// platform-specific `require('./keyring.<other-platform>.node')` calls inside
// @napi-rs/keyring's loader. tsup's built-in `native-node-modules` plugin
// then tries to resolve every one of those paths and fails because pnpm only
// installs the host's optionalDependency. We replace the loader at build
// time with a minimal shim that uses ONLY @napi-rs/keyring's documented
// NAPI_RS_NATIVE_LIBRARY_PATH escape hatch, which src/secrets/Keyring.ts sets
// to the sideloaded `keyring.<platform>.node` before requiring the package.
const replaceKeyringLoader = {
  name: "replace-napi-rs-keyring-loader",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]@napi-rs[\\/]keyring[\\/]index\.js$/ },
      () => ({
        contents: [
          "const __nativePath = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;",
          "if (!__nativePath) {",
          "  throw new Error('@napi-rs/keyring: NAPI_RS_NATIVE_LIBRARY_PATH must point at keyring.<platform>.node (set by src/secrets/Keyring.ts when the sideloaded binary is present next to the bundle).');",
          "}",
          "module.exports = require(__nativePath);",
        ].join("\n"),
        loader: "js",
      }),
    );
  },
};

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    splitting: false,
    // Pi loads extensions in an isolated context with no node_modules,
    // so bundle every runtime dep except the SDK Pi itself provides.
    //
    // Native-addon JS wrappers (better-sqlite3, @napi-rs/keyring) MUST be
    // bundled too — their compiled .node binaries are sideloaded next to the
    // bundle by install.sh / postinstall.mjs and resolved via the package's
    // official sideload API: better-sqlite3's `nativeBinding` constructor
    // option (used in Vault.ts) and @napi-rs/keyring's
    // NAPI_RS_NATIVE_LIBRARY_PATH env var (set in Keyring.ts).
    noExternal: ["shell-quote", "@sinclair/typebox", "better-sqlite3", "@napi-rs/keyring"],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ["@mariozechner/pi-coding-agent", "@mariozechner/pi-tui"],
    esbuildPlugins: [replaceKeyringLoader],
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
