/**
 * Release gate: prove the *packaged* binary works the way a user gets it.
 *
 * Runs against the globally installed `llmintel-mcp` (i.e. the tarball, not the source tree), so it
 * catches packaging faults that the vitest suite structurally cannot see: a missing `dist/cli.js`,
 * a dependency that was left in devDependencies, a broken `bin` mapping, a stripped shebang.
 *
 * Deliberately network-free. It only completes the MCP handshake and reads the tool manifest, so a
 * blip in the catalog API can never fail a release.
 *
 *   npm pack && npm install -g ./llmintel-mcp-*.tgz && node scripts/verify-install.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = [
  "check_model",
  "list_retiring_models",
  "suggest_replacement",
  "search_models",
  "recent_lifecycle_changes",
];

const mcp = new Client({ name: "llmintel-release-check", version: "0" });

await mcp.connect(
  new StdioClientTransport({
    command: "llmintel-mcp",
    // Point at a black hole: the handshake and tool manifest must not depend on the catalog being
    // reachable, and this fails loudly if some future change starts fetching during startup.
    env: { ...process.env, LLMINTEL_BASE_URL: "http://127.0.0.1:1" },
  }),
);

const found = (await mcp.listTools()).tools.map((t) => t.name).sort();
const missing = EXPECTED_TOOLS.filter((t) => !found.includes(t));

await mcp.close();

if (missing.length > 0) {
  console.error(`Installed binary is missing tools: ${missing.join(", ")}`);
  console.error(`Advertised: ${found.join(", ") || "(none)"}`);
  process.exit(1);
}

console.log(`Packaged binary handshakes and advertises ${found.length} tools: ${found.join(", ")}`);
