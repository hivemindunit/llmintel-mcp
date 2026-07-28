/**
 * Launch the built stdio server as a real child process and call each tool against a live catalog.
 *
 * The vitest suite drives the same protocol path against a fake catalog; this exists to check the
 * output an agent actually sees against *real* data, where date-vs-state edge cases show up.
 *
 *   pnpm --filter @llmintel/mcp build
 *   node scripts/smoke.mjs                                  # against production
 *   LLMINTEL_BASE_URL=http://localhost:3000 node scripts/smoke.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CALLS = [
  ["check_model", { model: "gpt-4o" }],
  ["list_retiring_models", { withinDays: 120 }],
  ["suggest_replacement", { model: "gpt-4o" }],
  ["recent_lifecycle_changes", { sinceDays: 30 }],
];

const mcp = new Client({ name: "llmintel-smoke", version: "0" });
await mcp.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["./dist/cli.js"],
    // The SDK forwards only an allowlisted env to the child, so pass overrides through explicitly.
    env: { ...process.env },
  }),
);

console.log("tools:", (await mcp.listTools()).tools.map((t) => t.name).join(", "));

for (const [name, args] of CALLS) {
  const result = await mcp.callTool({ name, arguments: args });
  console.log(`\n===== ${name} ${JSON.stringify(args)} =====`);
  if (result.isError) console.log("(reported as an error)");
  console.log(
    result.content
      .map((c) => c.text)
      .join("\n")
      .slice(0, 900),
  );
}

await mcp.close();
