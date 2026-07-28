import { defineConfig } from "tsup";

const shared = {
  // stdio MCP servers are launched by the host as a Node process; ESM only keeps the bundle small.
  format: ["esm" as const],
  sourcemap: true,
  treeshake: true,
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts"],
    dts: true,
    clean: true,
  },
  {
    ...shared,
    entry: ["src/cli.ts"],
    // Only the bin gets a shebang — a library entry with one confuses downstream bundlers.
    banner: { js: "#!/usr/bin/env node" },
  },
]);
