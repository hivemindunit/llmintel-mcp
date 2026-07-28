/**
 * stdio entry point. MCP hosts (Cursor, Claude Desktop/Code, Windsurf, …) launch this as a child
 * process and speak JSON-RPC over stdin/stdout.
 *
 * Nothing may be written to stdout except protocol frames — a stray console.log corrupts the
 * stream — so all diagnostics go to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CatalogClient, DEFAULT_BASE_URL } from "./client";
import { buildServer } from "./server";

async function main(): Promise<void> {
  const client = new CatalogClient({
    baseUrl: process.env.LLMINTEL_BASE_URL ?? DEFAULT_BASE_URL,
    // Optional: the catalog is public, a key only raises the rate-limit budget.
    apiKey: process.env.LLMINTEL_API_KEY,
  });

  const server = buildServer({ client });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error("[llmintel-mcp] fatal:", error);
  process.exit(1);
});
