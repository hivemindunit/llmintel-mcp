import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LIFECYCLE_STATES, PROVIDERS, type CatalogSource, type ModelSummary } from "./client";
import {
  assessRisk,
  daysUntil,
  formatEvents,
  formatModelList,
  formatModelReport,
  formatRetiringList,
  replacementIds,
} from "./format";

export const SERVER_NAME = "llmintel";
export const SERVER_VERSION = "0.2.0";

/**
 * Every tool here only reads the catalog, and the catalog is a service outside this process. Hosts
 * use `readOnlyHint` to decide what can run without a confirmation prompt, and Anthropic's directory
 * review requires the hint be present, so state it on all five rather than relying on a default.
 */
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/** Wrap tool output in the MCP content envelope. */
function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/**
 * A tool failure must not look like a factual answer — an agent that reads "not found" as "safe to
 * use" would happily ship a retired model id. Errors are flagged with `isError` so the host
 * surfaces them as failures.
 */
function failure(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true as const };
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Could not reach the LLMIntel catalog: ${message}. Do not infer a model's lifecycle state from this failure — the lookup did not complete.`;
}

export interface BuildServerOptions {
  client: CatalogSource;
  /** Injectable clock so "days until retirement" is deterministic in tests. */
  now?: () => Date;
}

/**
 * Build the MCP server exposing the LLMIntel model-lifecycle catalog.
 *
 * The tool surface is intentionally small and answers questions an agent actually has while writing
 * code that names a model: is this id safe, what replaces it, what's about to break, and what
 * changed recently.
 */
export function buildServer({ client, now = () => new Date() }: BuildServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "check_model",
    {
      title: "Check a model's lifecycle status",
      description:
        "Check whether an LLM model id is safe to use, deprecated, or retired, and what to " +
        "migrate to. Accepts the exact string used in code (e.g. 'gpt-4o', " +
        "'claude-sonnet-4-5-20250929', 'anthropic/claude-opus-4-1'). Call this before writing or " +
        "changing any hardcoded model id.",
      inputSchema: {
        model: z
          .string()
          .min(1)
          .describe("Model id or alias exactly as it appears in code, e.g. 'gpt-4o'."),
      },
      annotations: READ_ONLY,
    },
    async ({ model }) => {
      try {
        const detail = await client.getModel(model);
        if (!detail) {
          return text(
            `"${model}" is not in the LLMIntel catalog. That is not a safety verdict: it may be a ` +
              `very new model, a fine-tune, a self-hosted model, or a typo. Verify against the ` +
              `provider's own documentation before relying on it.`,
          );
        }
        return text(formatModelReport(detail, now(), model));
      } catch (error) {
        return failure(describeError(error));
      }
    },
  );

  server.registerTool(
    "list_retiring_models",
    {
      title: "List models retiring soon",
      description:
        "List tracked models scheduled to retire within a time window, soonest first. Use this to " +
        "audit a codebase or plan migration work.",
      inputSchema: {
        withinDays: z
          .number()
          .int()
          .positive()
          .max(1095)
          .default(180)
          .describe("Only include models retiring within this many days. Defaults to 180."),
        provider: z
          .enum(PROVIDERS)
          .optional()
          .describe("Restrict to one provider. Omit for all providers."),
      },
      annotations: READ_ONLY,
    },
    async ({ withinDays, provider }) => {
      try {
        // The catalog has no server-side "retiring within N days" filter, so pull the dated states
        // and window them here. Both states can carry a retirement date.
        const [retiring, deprecated] = await Promise.all([
          client.listModels({ provider, state: "retiring", limit: 500 }),
          client.listModels({ provider, state: "deprecated", limit: 500 }),
        ]);

        const at = now();
        const seen = new Set<string>();
        const due: ModelSummary[] = [];
        for (const model of [...retiring, ...deprecated]) {
          if (seen.has(model.id)) continue;
          seen.add(model.id);
          const days = daysUntil(model.retirementDate, at);
          if (days !== null && days <= withinDays) due.push(model);
        }

        return text(formatRetiringList(due, at, withinDays));
      } catch (error) {
        return failure(describeError(error));
      }
    },
  );

  server.registerTool(
    "suggest_replacement",
    {
      title: "Suggest a replacement for a model",
      description:
        "Given a deprecated or retiring model, return the provider's recommended replacement(s) " +
        "and, when none is published, active models from the same provider to consider.",
      inputSchema: {
        model: z.string().min(1).describe("Model id or alias to find a replacement for."),
      },
      annotations: READ_ONLY,
    },
    async ({ model }) => {
      try {
        const detail = await client.getModel(model);
        if (!detail) {
          return text(`"${model}" is not in the LLMIntel catalog, so no replacement is known.`);
        }

        const at = now();
        const risk = assessRisk(detail, at);
        const recommended = replacementIds(detail);

        if (recommended.length > 0) {
          const lines = [
            `Provider-recommended replacement(s) for ${detail.id}: ${recommended.join(", ")}`,
            "",
            "These come from the provider's own deprecation notice, not our editorial judgement.",
          ];
          if (detail.migration?.breakingNotes) {
            lines.push("", `Breaking changes to expect: ${detail.migration.breakingNotes}`);
          }
          if (detail.sourceUrl) lines.push("", `Source: ${detail.sourceUrl}`);
          return text(lines.join("\n"));
        }

        if (risk === "safe") {
          return text(
            `${detail.id} is active with no announced retirement, so no replacement is needed.`,
          );
        }

        // No provider-stated replacement: fall back to that provider's active models, and label the
        // list as editorial so the agent does not present it as a vendor recommendation.
        const active = await client.listModels({
          provider: detail.provider,
          state: "active",
          limit: 25,
        });
        if (active.length === 0) {
          return text(
            `${detail.provider} published no replacement for ${detail.id}, and we track no active ` +
              `${detail.provider} models to suggest. Check the provider's documentation.`,
          );
        }
        return text(
          [
            `${detail.provider} has not published a replacement for ${detail.id} ` +
              `(state: ${detail.lifecycleState}).`,
            "",
            "Active models from the same provider — candidates to evaluate, not a vendor recommendation:",
            "",
            formatModelList(active, at),
          ].join("\n"),
        );
      } catch (error) {
        return failure(describeError(error));
      }
    },
  );

  server.registerTool(
    "search_models",
    {
      title: "Search the model catalog",
      description:
        "List tracked models, optionally filtered by provider and lifecycle state. Use this to " +
        "discover what is currently available from a provider.",
      inputSchema: {
        provider: z.enum(PROVIDERS).optional().describe("Filter by provider."),
        state: z
          .enum(LIFECYCLE_STATES)
          .optional()
          .describe("Filter by canonical lifecycle state, e.g. 'active' or 'deprecated'."),
        limit: z.number().int().positive().max(200).default(50).describe("Maximum results."),
      },
      annotations: READ_ONLY,
    },
    async ({ provider, state, limit }) => {
      try {
        const models = await client.listModels({ provider, state, limit });
        return text(formatModelList(models, now()));
      } catch (error) {
        return failure(describeError(error));
      }
    },
  );

  server.registerTool(
    "recent_lifecycle_changes",
    {
      title: "Recent lifecycle changes",
      description:
        "Lifecycle state changes across all tracked providers, newest first. Use this to answer " +
        "'what model deprecations happened recently?'.",
      inputSchema: {
        sinceDays: z
          .number()
          .int()
          .positive()
          .max(365)
          .default(30)
          .describe("Look back this many days. Defaults to 30."),
        provider: z.enum(PROVIDERS).optional().describe("Restrict to one provider."),
      },
      annotations: READ_ONLY,
    },
    async ({ sinceDays, provider }) => {
      try {
        const since = new Date(now().getTime() - sinceDays * 86_400_000).toISOString();
        const events = await client.listEvents({ provider, since, limit: 100 });
        return text(formatEvents(events, since.slice(0, 10)));
      } catch (error) {
        return failure(describeError(error));
      }
    },
  );

  return server;
}
