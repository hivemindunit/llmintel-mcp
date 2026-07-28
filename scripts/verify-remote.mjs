/**
 * Drive the hosted Streamable HTTP endpoint the way an MCP host would.
 *
 * Defaults to the live site; pass a base URL to check a dev server or a preview deployment:
 *   node scripts/verify-remote.mjs http://localhost:3000
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.argv[2] ?? "https://llmintel.ai").replace(/\/+$/, "");
const url = new URL(`${base}/v1/mcp`);

const client = new Client({ name: "verify-remote", version: "0" });
await client.connect(new StreamableHTTPClientTransport(url));

const { tools } = await client.listTools();
console.log(`${url}\n  ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

const unannotated = tools.filter((t) => t.annotations?.readOnlyHint !== true);
if (unannotated.length > 0) {
  throw new Error(`missing readOnlyHint: ${unannotated.map((t) => t.name).join(", ")}`);
}
console.log("  every tool declares readOnlyHint");

for (const model of ["gpt-4o", "claude-opus-4-1"]) {
  const res = await client.callTool({ name: "check_model", arguments: { model } });
  const body = res.content[0].text;
  if (res.isError) throw new Error(`check_model(${model}) errored: ${body}`);
  if (!body.includes(model)) throw new Error(`check_model(${model}) did not mention the model`);
  console.log(`  check_model(${model}) -> ${body.split("\n")[0]}`);
}

const retiring = await client.callTool({
  name: "list_retiring_models",
  arguments: { withinDays: 90 },
});
console.log(`  list_retiring_models(90) -> ${retiring.content[0].text.split("\n")[0]}`);

await client.close();
console.log("OK");
