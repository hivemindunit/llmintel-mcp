import { describe, expect, it } from "vitest";
import type { ModelDetail, ModelSummary } from "./client";
import {
  assessRisk,
  daysUntil,
  formatModelReport,
  formatRetiringList,
  replacementIds,
} from "./format";

const NOW = new Date("2026-07-01T18:30:00Z");

function model(overrides: Partial<ModelSummary> = {}): ModelSummary {
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

function detail(overrides: Partial<ModelDetail> = {}): ModelDetail {
  return { ...model(), ...overrides };
}

describe("daysUntil", () => {
  it("counts whole calendar days in UTC, independent of the time of day", () => {
    // NOW is 18:30 UTC; a date 3 days out must read as 3, not 2 (truncation to UTC midnight).
    expect(daysUntil("2026-07-04", NOW)).toBe(3);
    expect(daysUntil("2026-07-01", NOW)).toBe(0);
  });

  it("returns negative days for dates in the past", () => {
    expect(daysUntil("2026-06-24", NOW)).toBe(-7);
  });

  it("is null-safe for missing or unparseable dates", () => {
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil(undefined, NOW)).toBeNull();
    expect(daysUntil("not-a-date", NOW)).toBeNull();
  });

  it("tolerates a full ISO timestamp, not just a date", () => {
    expect(daysUntil("2026-07-04T09:00:00Z", NOW)).toBe(3);
  });
});

describe("assessRisk", () => {
  it("treats a retired model as broken regardless of dates", () => {
    expect(assessRisk(model({ lifecycleState: "retired" }), NOW)).toBe("broken");
  });

  it("treats a past retirement date as broken even if the state lags behind", () => {
    // The catalog can be a beat behind the calendar; the date is the operational truth.
    expect(
      assessRisk(model({ lifecycleState: "deprecated", retirementDate: "2026-06-01" }), NOW),
    ).toBe("broken");
  });

  it("escalates an imminent retirement to urgent even from a deprecated state", () => {
    expect(
      assessRisk(model({ lifecycleState: "deprecated", retirementDate: "2026-08-01" }), NOW),
    ).toBe("urgent");
  });

  it("leaves a far-future retirement as a planning item", () => {
    expect(
      assessRisk(model({ lifecycleState: "deprecated", retirementDate: "2027-08-01" }), NOW),
    ).toBe("plan");
  });

  it("flags pre-GA models as watch rather than safe", () => {
    expect(assessRisk(model({ lifecycleState: "announced" }), NOW)).toBe("watch");
  });

  it("reports an undated active model as safe", () => {
    expect(assessRisk(model(), NOW)).toBe("safe");
  });
});

describe("formatModelReport", () => {
  it("leads with a do-not-use verdict for a retired model", () => {
    const report = formatModelReport(detail({ lifecycleState: "retired" }), NOW, "gpt-4o");
    expect(report.split("\n")[0]).toContain("DO NOT USE");
  });

  it("notes when the queried alias differs from the canonical id", () => {
    const report = formatModelReport(detail(), NOW, "gpt-4o");
    expect(report).toContain('"gpt-4o" resolves to the tracked model openai/gpt-4o-2024-05-13');
  });

  it("omits the alias note when the query is already canonical", () => {
    const report = formatModelReport(detail(), NOW, "openai/gpt-4o-2024-05-13");
    expect(report).not.toContain("resolves to the tracked model");
  });

  it("renders the retirement deadline in days, not just a raw date", () => {
    const report = formatModelReport(
      detail({ lifecycleState: "retiring", retirementDate: "2026-08-01" }),
      NOW,
      "gpt-4o",
    );
    expect(report).toContain("2026-08-01 (in 31 days)");
  });

  it("says so explicitly when a doomed model has no published replacement", () => {
    // Silence here would read as "nothing to do", which is the dangerous interpretation.
    const report = formatModelReport(detail({ lifecycleState: "deprecated" }), NOW, "gpt-4o");
    expect(report).toContain("has not named a replacement");
  });

  it("prefers the canonical id when a recommendation was resolved from a family slug", () => {
    const report = formatModelReport(
      detail({
        lifecycleState: "deprecated",
        migration: {
          recommendedReplacementIds: ["gpt-5"],
          resolvedReplacements: { "gpt-5": "openai/gpt-5-2026-01-10" },
        },
      }),
      NOW,
      "gpt-4o",
    );
    expect(report).toContain("openai/gpt-5-2026-01-10");
  });
});

describe("replacementIds", () => {
  it("passes through ids the catalog could not resolve", () => {
    expect(
      replacementIds(detail({ migration: { recommendedReplacementIds: ["some-future-model"] } })),
    ).toEqual(["some-future-model"]);
  });

  it("is empty when there is no migration payload", () => {
    expect(replacementIds(detail())).toEqual([]);
  });
});

describe("formatRetiringList", () => {
  it("states the window when nothing is due", () => {
    expect(formatRetiringList([], NOW, 90)).toContain("No tracked models are scheduled to retire");
  });

  it("orders upcoming retirements by soonest deadline", () => {
    const listed = formatRetiringList(
      [
        model({ id: "b/late", retirementDate: "2026-12-01" }),
        model({ id: "a/soon", retirementDate: "2026-07-15" }),
      ],
      NOW,
      180,
    );
    expect(listed.indexOf("a/soon")).toBeLessThan(listed.indexOf("b/late"));
  });

  it("separates past-due models from upcoming ones and lists them first", () => {
    // A past-due model is already broken; grouping it under "retiring soon" would read as
    // future work. The catalog can still label it `retiring`, so the date has to drive the split.
    const listed = formatRetiringList(
      [
        model({ id: "c/upcoming", lifecycleState: "retiring", retirementDate: "2026-08-15" }),
        model({ id: "z/overdue", lifecycleState: "retiring", retirementDate: "2026-06-10" }),
      ],
      NOW,
      180,
    );

    expect(listed).toContain("PAST their retirement date");
    expect(listed).toContain("z/overdue");
    expect(listed).toContain("passed 21 days ago");
    expect(listed.indexOf("z/overdue")).toBeLessThan(listed.indexOf("c/upcoming"));
    expect(listed).toContain("1 model(s) retiring within 180 days");
  });

  it("reports when every match is already past due", () => {
    const listed = formatRetiringList(
      [model({ id: "z/overdue", retirementDate: "2026-06-10" })],
      NOW,
      180,
    );
    expect(listed).toContain("No further retirements are scheduled within 180 days.");
  });
});
