/**
 * Pure presentation logic for the MCP tools.
 *
 * These functions produce the *text an LLM reads*, so they are written for a machine consumer that
 * will act on the answer: lead with the verdict, state the deadline in days (a model cannot reason
 * reliably about whether 2026-10-14 is soon), and always name the replacement and the source.
 */

import type { LifecycleEvent, LifecycleState, ModelDetail, ModelSummary } from "./client";

/** How much attention a model's lifecycle state demands right now. */
export type Risk = "broken" | "urgent" | "plan" | "watch" | "safe";

/** Anything retiring within this window is treated as urgent rather than merely scheduled. */
export const URGENT_WINDOW_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/**
 * Whole days from `now` until an ISO date, or null when the date is absent/unparseable.
 * Negative means the date has passed. Both sides are truncated to UTC midnight so the result is a
 * stable calendar-day count rather than depending on the time of day the tool is called.
 */
export function daysUntil(date: string | null | undefined, now: Date): number | null {
  if (!date) return null;
  const target = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(target)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / MS_PER_DAY);
}

/**
 * Classify a model's urgency. Lifecycle state is authoritative for what *has* happened; the
 * retirement date refines how soon it matters.
 */
export function assessRisk(model: ModelSummary, now: Date): Risk {
  const days = daysUntil(model.retirementDate, now);

  // Retired means calls already fail — nothing else outranks that.
  if (model.lifecycleState === "retired") return "broken";
  if (days !== null && days < 0) return "broken";
  if (days !== null && days <= URGENT_WINDOW_DAYS) return "urgent";

  switch (model.lifecycleState) {
    case "retiring":
      return "urgent";
    case "deprecated":
    case "legacy":
      return "plan";
    case "announced":
      return "watch";
    default:
      return "safe";
  }
}

const RISK_VERDICT: Record<Risk, string> = {
  broken: "DO NOT USE — this model is retired; API calls to it fail.",
  urgent: "ACT NOW — this model is retiring imminently.",
  plan: "PLAN A MIGRATION — this model is deprecated and will be retired.",
  watch: "NOT YET GENERALLY AVAILABLE — this model is pre-GA and may change or be withdrawn.",
  safe: "OK — this model is active with no announced retirement.",
};

const STATE_MEANING: Record<LifecycleState, string> = {
  announced: "announced but not generally available",
  active: "generally available",
  legacy: "superseded but still callable",
  deprecated: "closed to new use; existing calls still work",
  retiring: "retirement scheduled",
  retired: "retired; calls fail",
};

function formatDeadline(days: number | null, date: string | null | undefined): string | null {
  if (!date) return null;
  if (days === null) return date;
  if (days < 0) return `${date} (${Math.abs(days)} days ago)`;
  if (days === 0) return `${date} (today)`;
  return `${date} (in ${days} days)`;
}

/** Replacement ids for a model, canonicalised where the catalog could resolve them. */
export function replacementIds(model: ModelDetail): string[] {
  const raw = model.migration?.recommendedReplacementIds ?? [];
  const resolved = model.migration?.resolvedReplacements ?? {};
  return raw.map((id) => resolved[id] ?? id);
}

/**
 * The full answer to "can I use this model?". Deliberately verbose about *why*, because the agent
 * relays this reasoning to the developer rather than just the verdict.
 */
export function formatModelReport(model: ModelDetail, now: Date, query: string): string {
  const risk = assessRisk(model, now);
  const lines: string[] = [RISK_VERDICT[risk], ""];

  if (query.toLowerCase() !== model.id.toLowerCase()) {
    lines.push(`"${query}" resolves to the tracked model ${model.id}.`);
  }

  lines.push(
    `Model: ${model.displayName} (${model.id})`,
    `Provider: ${model.provider}`,
    `Lifecycle state: ${model.lifecycleState} — ${STATE_MEANING[model.lifecycleState]}`,
  );

  const retirement = formatDeadline(daysUntil(model.retirementDate, now), model.retirementDate);
  const deprecation = formatDeadline(daysUntil(model.deprecatedDate, now), model.deprecatedDate);
  if (deprecation) lines.push(`Deprecated: ${deprecation}`);
  if (retirement) lines.push(`Retirement: ${retirement}`);
  if (!retirement && risk !== "safe") lines.push("Retirement: no date published yet.");

  const replacements = replacementIds(model);
  if (replacements.length > 0) {
    lines.push("", `Recommended replacement(s): ${replacements.join(", ")}`);
  } else if (risk === "broken" || risk === "urgent" || risk === "plan") {
    // Say so explicitly — silence would read as "no migration needed".
    lines.push("", "The provider has not named a replacement. Use suggest_replacement for options.");
  }

  if (model.migration?.breakingNotes) {
    lines.push(`Breaking changes: ${model.migration.breakingNotes}`);
  }

  const spec = model.spec;
  if (spec?.inputUsdPerMillion != null || spec?.outputUsdPerMillion != null) {
    const input = spec.inputUsdPerMillion != null ? `$${spec.inputUsdPerMillion}/1M in` : null;
    const output = spec.outputUsdPerMillion != null ? `$${spec.outputUsdPerMillion}/1M out` : null;
    const context = spec.contextWindow != null ? `${spec.contextWindow} ctx` : null;
    lines.push(`Pricing/limits: ${[input, output, context].filter(Boolean).join(" · ")}`);
  }

  if (model.sourceUrl) {
    lines.push("", `Source: ${model.sourceUrl}`);
    if (model.sourceTerm) lines.push(`Provider's own term: "${model.sourceTerm}"`);
  }

  return lines.join("\n");
}

/** Sort key: soonest real deadline first, undated entries last. */
function retirementRank(model: ModelSummary, now: Date): number {
  const days = daysUntil(model.retirementDate, now);
  return days ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Render a retirement window, splitting deadlines that have already passed from those still ahead.
 *
 * The split matters: a model whose retirement date is in the past is already broken, and burying it
 * in a list headed "retiring soon" invites an agent to treat it as future work. Past-due entries
 * are listed first and named for what they are.
 */
export function formatRetiringList(models: ModelSummary[], now: Date, withinDays: number): string {
  if (models.length === 0) {
    return `No tracked models are scheduled to retire within ${withinDays} days.`;
  }

  const sorted = [...models].sort((a, b) => retirementRank(a, now) - retirementRank(b, now));
  const overdue = sorted.filter((m) => (daysUntil(m.retirementDate, now) ?? 0) < 0);
  const upcoming = sorted.filter((m) => (daysUntil(m.retirementDate, now) ?? 0) >= 0);

  const lines: string[] = [];

  if (overdue.length > 0) {
    lines.push(
      `${overdue.length} model(s) are PAST their retirement date — calls to these should be ` +
        `assumed to fail. Migrate immediately:`,
      "",
    );
    for (const model of overdue) {
      const days = Math.abs(daysUntil(model.retirementDate, now) ?? 0);
      lines.push(
        `- ${model.id} (${model.provider}) — retirement date passed ${days} days ago ` +
          `(${model.retirementDate})`,
      );
    }
    lines.push("");
  }

  if (upcoming.length > 0) {
    lines.push(`${upcoming.length} model(s) retiring within ${withinDays} days, soonest first:`, "");
    for (const model of upcoming) {
      const days = daysUntil(model.retirementDate, now);
      const when = days === 0 ? "today" : `in ${days} days`;
      lines.push(
        `- ${model.id} (${model.provider}) — ${when} (${model.retirementDate}) ` +
          `[${model.lifecycleState}]`,
      );
    }
  } else {
    lines.push(`No further retirements are scheduled within ${withinDays} days.`);
  }

  return lines.join("\n").trimEnd();
}

export function formatEvents(events: LifecycleEvent[], since: string | undefined): string {
  if (events.length === 0) {
    return since
      ? `No lifecycle changes recorded since ${since}.`
      : "No lifecycle changes recorded.";
  }

  const lines = [`${events.length} lifecycle change(s), newest first:`, ""];
  for (const event of events) {
    const from = event.fromState ?? "new";
    lines.push(
      `- ${event.detectedAt.slice(0, 10)} ${event.modelId}: ${from} -> ${event.toState}`,
    );
  }
  return lines.join("\n");
}

export function formatModelList(models: ModelSummary[], now: Date): string {
  if (models.length === 0) return "No models matched.";

  const lines = [`${models.length} model(s):`, ""];
  for (const model of models) {
    const risk = assessRisk(model, now);
    const days = daysUntil(model.retirementDate, now);
    const suffix = days !== null && days >= 0 ? `, retires in ${days} days` : "";
    lines.push(`- ${model.id} — ${model.lifecycleState}${suffix} [${risk}]`);
  }
  return lines.join("\n");
}
