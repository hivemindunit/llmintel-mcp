import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { CatalogClient, type ModelDetail, type ModelSummary } from "./client";
import { buildServer } from "./server";

const NOW = new Date("2026-07-01T00:00:00Z");

interface Routes {
  models?: ModelSummary[];
  detail?: Record<string, ModelDetail>;
  events?: unknown[];
  /** Force a transport failure to prove errors are not reported as facts. */
  fail?: boolean;
}

/**
 * A fake `fetch` that serves the catalog's public shape. Keeps the test on the real MCP protocol
 * path (client -> transport -> server -> tool) while keeping the network out of it.
 */
function fakeFetch(routes: Routes): typeof fetch {
  return (async (input: string | URL) => {
    if (routes.fail) throw new Error("network down");

    const url = new URL(String(input));
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (url.pathname.startsWith("/v1/models/")) {
      const ref = decodeURIComponent(url.pathname.slice("/v1/models/".length));
      const found = routes.detail?.[ref];
      if (!found) return new Response("not found", { status: 404 });
      return json({ data: found });
    }
    if (url.pathname === "/v1/models") {
      const state = url.searchParams.get("state");
      const all = routes.models ?? [];
      return json({ data: state ? all.filter((m) => m.lifecycleState === state) : all });
    }
    if (url.pathname === "/v1/events") return json({ data: routes.events ?? [] });
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

async function connect(routes: Routes) {
  const client = new CatalogClient({
    baseUrl: "https://example.test",
    fetchImpl: fakeFetch(routes),
  });
  const server = buildServer({ client, now: () => NOW });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)]);
  return mcp;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function summary(overrides: Partial<ModelSummary> = {}): ModelSummary {
  return {
    id: "openai/gpt-4o-2024-05-13",
    provider: "openai",
    displayName: "GPT-4o",
    lifecycleState: "active",
    announcedDate: null,
    deprecatedDate: null,
    retirementDate: null,
    sourceUrl: "https://platform.openai.com/docs/deprecations",
    ...overrides,
  };
}

describe("llmintel MCP server", () => {
  it("advertises the lifecycle tools an agent needs", async () => {
    const mcp = await connect({});
    const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "check_model",
      "list_retiring_models",
      "recent_lifecycle_changes",
      "search_models",
      "suggest_replacement",
    ]);
  });

  it("check_model resolves a bare alias and leads with the verdict", async () => {
    const mcp = await connect({
      detail: {
        "gpt-4o": {
          ...summary({ lifecycleState: "retiring", retirementDate: "2026-08-01" }),
          migration: { recommendedReplacementIds: ["openai/gpt-5"] },
        },
      },
    });

    const body = textOf(await mcp.callTool({ name: "check_model", arguments: { model: "gpt-4o" } }));
    expect(body.split("\n")[0]).toContain("ACT NOW");
    expect(body).toContain("in 31 days");
    expect(body).toContain("openai/gpt-5");
  });

  it("check_model refuses to imply an untracked model is safe", async () => {
    const mcp = await connect({ detail: {} });
    const body = textOf(
      await mcp.callTool({ name: "check_model", arguments: { model: "mystery-model" } }),
    );
    expect(body).toContain("not in the LLMIntel catalog");
    expect(body).toContain("not a safety verdict");
  });

  it("reports a transport failure as an error, never as a lifecycle answer", async () => {
    const mcp = await connect({ fail: true });
    const result = await mcp.callTool({ name: "check_model", arguments: { model: "gpt-4o" } });
    // An agent must not read a failed lookup as "no deprecation found".
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Do not infer");
  });

  it("list_retiring_models windows by date and merges both dated states", async () => {
    const mcp = await connect({
      models: [
        summary({ id: "a/soon", lifecycleState: "retiring", retirementDate: "2026-07-20" }),
        summary({ id: "b/deprecated", lifecycleState: "deprecated", retirementDate: "2026-08-10" }),
        summary({ id: "c/far", lifecycleState: "retiring", retirementDate: "2028-01-01" }),
        summary({ id: "d/undated", lifecycleState: "deprecated" }),
      ],
    });

    const body = textOf(
      await mcp.callTool({ name: "list_retiring_models", arguments: { withinDays: 90 } }),
    );
    expect(body).toContain("a/soon");
    expect(body).toContain("b/deprecated");
    // Outside the window, and undated entries can't be shown to breach it.
    expect(body).not.toContain("c/far");
    expect(body).not.toContain("d/undated");
    expect(body.indexOf("a/soon")).toBeLessThan(body.indexOf("b/deprecated"));
  });

  it("suggest_replacement labels a same-provider fallback as non-authoritative", async () => {
    const mcp = await connect({
      detail: { "old-model": { ...summary({ id: "openai/old", lifecycleState: "deprecated" }) } },
      models: [summary({ id: "openai/new", lifecycleState: "active" })],
    });

    const body = textOf(
      await mcp.callTool({ name: "suggest_replacement", arguments: { model: "old-model" } }),
    );
    expect(body).toContain("has not published a replacement");
    expect(body).toContain("not a vendor recommendation");
    expect(body).toContain("openai/new");
  });

  it("suggest_replacement returns the provider's own recommendation when there is one", async () => {
    const mcp = await connect({
      detail: {
        "old-model": {
          ...summary({ id: "openai/old", lifecycleState: "deprecated" }),
          migration: {
            recommendedReplacementIds: ["gpt-5"],
            resolvedReplacements: { "gpt-5": "openai/gpt-5-2026-01-10" },
          },
        },
      },
    });

    const body = textOf(
      await mcp.callTool({ name: "suggest_replacement", arguments: { model: "old-model" } }),
    );
    expect(body).toContain("openai/gpt-5-2026-01-10");
    expect(body).toContain("not our editorial judgement");
  });

  it("suggest_replacement short-circuits for a healthy model", async () => {
    const mcp = await connect({ detail: { "gpt-4o": { ...summary() } } });
    const body = textOf(
      await mcp.callTool({ name: "suggest_replacement", arguments: { model: "gpt-4o" } }),
    );
    expect(body).toContain("no replacement is needed");
  });
});
