import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_NAME, SERVER_VERSION } from "./server";

/**
 * A release carries the same version number in four places: `package.json`, both `version` fields in
 * `server.json`, and `SERVER_VERSION` here. Only the first is checked at release time, by the
 * tag-vs-package.json guard in `.github/workflows/publish-mcp.yml`. A partial bump therefore ships to
 * npm and only surfaces later, when `mcp-publisher validate` rejects the registry update, or never,
 * if the operator does not run it. These tests turn that into a CI failure at the moment of the bump.
 */

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PKG_ROOT, name), "utf8")) as Record<string, unknown>;
}

const pkg = readJson("package.json");
const registry = readJson("server.json");

/** Read the sole npm package entry, asserting the shape the rest of the file relies on. */
function npmEntry(): Record<string, unknown> {
  const packages = registry.packages as Array<Record<string, unknown>> | undefined;
  expect(packages, "packages[] in server.json").toBeDefined();
  expect(packages).toHaveLength(1);
  const [entry] = packages as Array<Record<string, unknown>>;
  if (!entry) throw new Error("server.json packages[0] missing");
  return entry;
}

/** Read the sole remote entry the same way. */
function remoteEntry(): Record<string, unknown> {
  const remotes = registry.remotes as Array<Record<string, unknown>> | undefined;
  expect(remotes, "remotes[] in server.json").toBeDefined();
  expect(remotes).toHaveLength(1);
  const [entry] = remotes as Array<Record<string, unknown>>;
  if (!entry) throw new Error("server.json remotes[0] missing");
  return entry;
}

describe("release metadata", () => {
  it("agrees on the version across every copy of it", () => {
    const version = pkg.version as string;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);

    expect(SERVER_VERSION, "SERVER_VERSION in src/server.ts").toBe(version);
    expect(registry.version, "top-level version in server.json").toBe(version);
    expect(npmEntry().version, "packages[0].version in server.json").toBe(version);
  });

  it("keeps mcpName equal to the registry name that holds the namespace", () => {
    // The registry reads `mcpName` out of the published tarball to confirm the package belongs to
    // `ai.llmintel/*`. If the two drift, namespace validation fails on publish.
    expect(pkg.mcpName).toBe(registry.name);
    expect(registry.name).toBe("ai.llmintel/model-lifecycle");
  });

  it("points the registry entry at the package it actually publishes", () => {
    const entry = npmEntry();
    expect(entry.identifier).toBe(pkg.name);
    expect(entry.registryType).toBe("npm");
  });

  it("ships the files the mirror and the registry both depend on", () => {
    // `server.json` must reach the npm tarball. `glama.json` and `smithery.yaml` must NOT: they are
    // mirror-only directory metadata, and the sync job asserts their presence separately.
    const files = pkg.files as string[];
    expect(files).toContain("server.json");
    expect(files).not.toContain("glama.json");
    expect(files).not.toContain("smithery.yaml");
  });

  it("points the Smithery config at the same endpoint the registry advertises", () => {
    // Smithery stores listing config server-side; this file is the reviewable copy. If it drifts
    // from `remotes`, a re-scan would publish a listing aimed somewhere we no longer serve.
    const yaml = readFileSync(join(PKG_ROOT, "smithery.yaml"), "utf8");
    expect(yaml).toContain(`url: ${remoteEntry().url}`);
    expect(yaml).toContain("type: streamableHttp");
    expect(yaml).toContain("target: remote");
  });

  it("keeps the registry description inside the 100-character cap", () => {
    // The live registry rejects anything longer, which is only discoverable at publish time.
    expect((registry.description as string).length).toBeLessThanOrEqual(100);
  });

  it("advertises the hosted endpoint the server card also names", () => {
    expect(remoteEntry()).toEqual({
      type: "streamable-http",
      url: "https://llmintel.ai/v1/mcp",
    });
  });

  it("uses the server name the hosted endpoint reports", () => {
    expect(SERVER_NAME).toBe("llmintel");
  });
});
