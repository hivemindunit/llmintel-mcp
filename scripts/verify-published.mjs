/**
 * Post-release check: drive the *published* package straight from the registry, spawned the way an
 * MCP host spawns it (no shell), against the live catalog.
 *
 *   node scripts/verify-published.mjs
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Read the version from package.json rather than hardcoding it. A pinned spec silently rots into
 * checking a version you released three bumps ago, which passes while the actual new release is
 * broken. `npm view` is not consulted: this must verify the version we just tagged, not whatever
 * npm currently calls `latest`.
 */
const pkg = JSON.parse(
  readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), "package.json"), "utf8"),
);
const SPEC = `${pkg.name}@${pkg.version}`;

/**
 * Spawn from a scratch directory, never the repo. Run inside packages/mcp and npx resolves
 * `@llmintel/mcp` to this very workspace package, then fails to find a bin that pnpm never links
 * into a package's own node_modules/.bin — a false failure that looks exactly like a broken release.
 */
const NEUTRAL_CWD = mkdtempSync(join(tmpdir(), "llmintel-mcp-check-"));

/** How a host on this platform would launch the server, plus the documented Windows fallback. */
const LAUNCHERS =
  process.platform === "win32"
    ? [
        { label: 'npx.cmd -y (what "command": "npx" does)', command: "npx.cmd", args: ["-y", SPEC] },
        { label: "cmd /c npx -y (Windows fallback)", command: "cmd", args: ["/c", "npx", "-y", SPEC] },
      ]
    : [{ label: "npx -y", command: "npx", args: ["-y", SPEC] }];

for (const { label, command, args } of LAUNCHERS) {
  const mcp = new Client({ name: "post-release-check", version: "0" });
  try {
    await mcp.connect(
      new StdioClientTransport({ command, args, cwd: NEUTRAL_CWD, env: { ...process.env } }),
    );
  } catch (error) {
    console.log(`FAIL  ${label}\n      ${error.message}\n`);
    continue;
  }

  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  const report = await mcp.callTool({ name: "check_model", arguments: { model: "gpt-4o" } });
  const firstLine = report.content.map((c) => c.text).join("\n").split("\n")[0];

  console.log(`OK    ${label}`);
  console.log(`      ${tools.length} tools | check_model("gpt-4o") -> ${firstLine}\n`);
  await mcp.close();
}
