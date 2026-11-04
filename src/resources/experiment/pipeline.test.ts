import { describe, expect, it } from "vitest";
import { diff } from "../../apply/diff.js";
import { newApplyContext, type DesiredState } from "../types.js";
import type { ServerCohort } from "../cohort/client.js";
import { cohort } from "../cohort/sdk.js";
import { featureFlag, type FeatureFlag } from "../feature-flag/sdk.js";
import { experimentHoldout } from "../experiment-holdout/sdk.js";
import { experimentSavedMetric } from "../experiment-saved-metric/sdk.js";
import { experiment, type Experiment } from "./sdk.js";
import type { ServerExperiment } from "./client.js";
import {
  buildCreatePayload,
  displayExperiment,
  displayExperimentFromServer,
  experimentHash,
  resolveCohortRefs,
  validateExperiments,
} from "./pipeline.js";

const flag: FeatureFlag = featureFlag({
  key: "my-flag",
  filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
});

const billingMetric = experimentSavedMetric({
  key: "billing-conv",
  name: "Billing conversion",
  query: { kind: "ExperimentMetric", metric_type: "mean" },
});

const euHoldout = experimentHoldout({
  key: "eu-only",
  name: "EU holdout",
  filters: [{ properties: [], rollout_percentage: 10 }],
});

function spec(key: string, overrides: Partial<Experiment> = {}): Experiment {
  return experiment({
    key,
    name: `Experiment ${key}`,
    featureFlag: flag,
    ...overrides,
  });
}

function marker(key: string, hash: string): string {
  return `<!-- iac:experiments:${key} iac:hash:${hash} -->`;
}

function serverRow(
  id: number,
  key: string,
  hash: string,
  overrides: Partial<ServerExperiment> = {},
): ServerExperiment {
  return {
    id,
    name: `Experiment ${key}`,
    description: marker(key, hash),
    feature_flag_key: "my-flag",
    archived: false,
    metrics: [],
    metrics_secondary: [],
    saved_metrics: [],
    status: "draft",
    ...overrides,
  };
}

function desiredFor(args: {
  experiments: Experiment[];
  flags?: FeatureFlag[];
  holdouts?: Array<ReturnType<typeof experimentHoldout>>;
  savedMetrics?: Array<ReturnType<typeof experimentSavedMetric>>;
  cohorts?: Array<ReturnType<typeof cohort>>;
}): DesiredState {
  const state: DesiredState = new Map();
  for (const k of ["insights", "dashboards", "endpoints", "property-groups", "event-definitions"]) {
    state.set(k, []);
  }
  state.set(
    "cohorts",
    (args.cohorts ?? []).map((spec) => ({ path: "<test>", spec })),
  );
  state.set(
    "feature-flags",
    (args.flags ?? [flag]).map((spec) => ({ path: "<test>", spec })),
  );
  state.set(
    "experiment-holdouts",
    (args.holdouts ?? []).map((spec) => ({ path: "<test>", spec })),
  );
  state.set(
    "experiment-saved-metrics",
    (args.savedMetrics ?? []).map((spec) => ({ path: "<test>", spec })),
  );
  state.set(
    "experiments",
    args.experiments.map((spec) => ({ path: "<test>", spec })),
  );
  return state;
}

function currentFor(rows: ServerExperiment[]): Map<string, unknown[]> {
  return new Map<string, unknown[]>([
    ["insights", []],
    ["dashboards", []],
    ["feature-flags", []],
    ["endpoints", []],
    ["property-groups", []],
    ["event-definitions", []],
    ["experiment-holdouts", []],
    ["experiment-saved-metrics", []],
    ["experiments", rows],
  ]);
}

describe("experiment pipeline", () => {
  it("creates when no server row matches", () => {
    const result = diff(desiredFor({ experiments: [spec("onboarding")] }), currentFor([]));
    expect(result.get("experiments")!.ops[0]!.kind).toBe("create");
  });

  it("unchanged when hashes match", () => {
    const desired = spec("onboarding");
    const server = serverRow(11, "onboarding", experimentHash(desired));
    expect(
      diff(desiredFor({ experiments: [desired] }), currentFor([server])).get("experiments")!.ops[0]!
        .kind,
    ).toBe("unchanged");
  });

  it("updates when hash differs", () => {
    const desired = spec("onboarding");
    const server = serverRow(11, "onboarding", "stale");
    expect(
      diff(desiredFor({ experiments: [desired] }), currentFor([server])).get("experiments")!.ops[0]!
        .kind,
    ).toBe("update");
  });

  it("update fires when lifecycle changes", () => {
    const desiredDraft = spec("onboarding", { lifecycle: "draft" });
    const desiredRunning = spec("onboarding", { lifecycle: "running" });
    expect(experimentHash(desiredDraft)).not.toBe(experimentHash(desiredRunning));
  });

  it("dates are create-only: adding them leaves an existing experiment unchanged", () => {
    const undated = spec("onboarding", { lifecycle: "stopped", conclusion: "won" });
    const dated = spec("onboarding", {
      lifecycle: "stopped",
      conclusion: "won",
      startDate: "2026-10-09T20:07:06Z",
      endDate: "2026-10-19T07:28:04Z",
    });
    expect(experimentHash(dated)).toBe(experimentHash(undated));
    const server = serverRow(11, "onboarding", experimentHash(undated), { status: "stopped" });
    expect(
      diff(desiredFor({ experiments: [dated] }), currentFor([server])).get("experiments")!.ops[0]!
        .kind,
    ).toBe("unchanged");
  });

  it("create leaves the flag's own config out of parameters", () => {
    const exp = spec("onboarding", {
      parameters: {
        feature_flag_variants: [
          { key: "control", rollout_percentage: 50 },
          { key: "test", rollout_percentage: 50 },
        ],
        rollout_percentage: 100,
        minimum_detectable_effect: 5,
      },
    });
    const payload = buildCreatePayload(exp, experimentHash(exp), newApplyContext());
    expect(payload.parameters).toEqual({ minimum_detectable_effect: 5 });
    const flagOnly = spec("onboarding", { parameters: { rollout_percentage: 100 } });
    expect(buildCreatePayload(flagOnly, experimentHash(flagOnly), newApplyContext())).not.toHaveProperty(
      "parameters",
    );
  });

  it("safety invariant: ignores rows without marker", () => {
    const handBuilt: ServerExperiment = {
      id: 99,
      name: "Hand-built",
      description: "no marker here",
      feature_flag_key: "x",
      archived: false,
      metrics: [],
      metrics_secondary: [],
      saved_metrics: [],
    };
    const result = diff(desiredFor({ experiments: [] }), currentFor([handBuilt]));
    const slice = result.get("experiments")!;
    expect(slice.ops.length).toBe(0);
    expect(slice.orphans.length).toBe(0);
  });
});

describe("experiment validation", () => {
  it("rejects reference to undeclared flag", () => {
    const orphan: FeatureFlag = featureFlag({
      key: "orphan-flag",
      filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
    });
    const exp = spec("onboarding", { featureFlag: orphan });
    const issues = validateExperiments([exp], desiredFor({ experiments: [exp], flags: [] }));
    expect(issues.some((m) => m.includes("unknown feature flag"))).toBeTruthy();
  });

  it("rejects archived without stopped lifecycle", () => {
    const exp = spec("onboarding", { archived: true });
    const issues = validateExperiments([exp], desiredFor({ experiments: [exp] }));
    expect(issues.some((m) => m.includes("can only be archived"))).toBeTruthy();
  });

  it("requires conclusion when lifecycle is stopped", () => {
    const exp = spec("onboarding", { lifecycle: "stopped" });
    const issues = validateExperiments([exp], desiredFor({ experiments: [exp] }));
    expect(issues.some((m) => m.includes("requires a conclusion"))).toBeTruthy();
  });

  it("variant rollout percentages must sum to 100", () => {
    const exp = spec("onboarding", {
      parameters: {
        feature_flag_variants: [
          { key: "control", rollout_percentage: 30 },
          { key: "test", rollout_percentage: 30 },
        ],
      },
    });
    const issues = validateExperiments([exp], desiredFor({ experiments: [exp] }));
    expect(issues.some((m) => m.includes("sum to 60"))).toBeTruthy();
  });

  it("rejects unknown holdout reference", () => {
    const exp = spec("onboarding", { holdout: euHoldout });
    const issues = validateExperiments(
      [exp],
      desiredFor({ experiments: [exp], holdouts: [] }),
    );
    expect(issues.some((m) => m.includes("unknown experiment holdout"))).toBeTruthy();
  });

  it("rejects unknown saved metric reference", () => {
    const exp = spec("onboarding", { primarySavedMetrics: [billingMetric] });
    const issues = validateExperiments(
      [exp],
      desiredFor({ experiments: [exp], savedMetrics: [] }),
    );
    expect(issues.some((m) => m.includes("unknown experiment saved metric"))).toBeTruthy();
  });

  it("rejects a startDate on a draft or one that isn't a timestamp", () => {
    for (const exp of [
      spec("onboarding", { startDate: "2026-10-09T20:07:06Z" }),
      spec("onboarding", { lifecycle: "running", startDate: "last tuesday" }),
    ]) {
      const issues = validateExperiments([exp], desiredFor({ experiments: [exp] }));
      expect(issues.some((m) => m.includes("startDate must be"))).toBeTruthy();
    }
  });

  it("rejects an endDate unless a stopped experiment starts before it", () => {
    for (const exp of [
      spec("onboarding", { lifecycle: "running", startDate: "2026-10-09T20:07:06Z", endDate: "2026-10-19T00:00:00Z" }),
      spec("onboarding", { lifecycle: "stopped", conclusion: "won", endDate: "2026-10-19T00:00:00Z" }),
      spec("onboarding", {
        lifecycle: "stopped",
        conclusion: "won",
        startDate: "2026-10-19T00:00:00Z",
        endDate: "2026-10-09T20:07:06Z",
      }),
    ]) {
      const issues = validateExperiments([exp], desiredFor({ experiments: [exp] }));
      expect(issues.some((m) => m.includes("endDate must be"))).toBeTruthy();
    }
  });

  it("accepts dates on a running and a stopped experiment", () => {
    const running = spec("running-one", { lifecycle: "running", startDate: "2026-10-09T20:07:06.275Z" });
    const stopped = spec("stopped-one", {
      lifecycle: "stopped",
      conclusion: "won",
      startDate: "2026-10-09T20:07:06Z",
      endDate: "2026-10-19T07:28:04Z",
    });
    expect(
      validateExperiments([running, stopped], desiredFor({ experiments: [running, stopped] })),
    ).toEqual([]);
  });

  it("accepts a minimal valid spec", () => {
    const exp = spec("onboarding");
    expect(validateExperiments([exp], desiredFor({ experiments: [exp] }))).toEqual([]);
  });

  it("accepts a full spec with all refs declared", () => {
    const exp = spec("onboarding", {
      lifecycle: "stopped",
      conclusion: "won",
      conclusionComment: "Test won",
      archived: true,
      holdout: euHoldout,
      primarySavedMetrics: [billingMetric],
    });
    const issues = validateExperiments(
      [exp],
      desiredFor({
        experiments: [exp],
        holdouts: [euHoldout],
        savedMetrics: [billingMetric],
      }),
    );
    expect(issues).toEqual([]);
  });
});

describe("experiment cohort references", () => {
  const internal = cohort({
    key: "internal-users",
    name: "Internal Users",
    filters: { properties: { type: "OR", values: [] } },
  });

  function excluding(value: unknown): Experiment {
    const notIn = [{ key: "id", type: "cohort", value, operator: "not_in" }];
    return spec("jev", {
      lifecycle: "running",
      exposure_criteria: {
        filterTestAccounts: true,
        exposure_config: { kind: "ExperimentEventExposureConfig", event: "jev_exposure", properties: notIn },
      },
      metrics: [
        {
          kind: "ExperimentMetric",
          metric_type: "mean",
          source: { kind: "EventsNode", event: "flashcard:delete", properties: notIn },
        },
      ],
    });
  }

  function cohortValues(body: { metrics?: unknown; exposure_criteria?: unknown }): unknown[] {
    const exposure = body.exposure_criteria as { exposure_config: { properties: Array<{ value: unknown }> } };
    const metrics = body.metrics as Array<{ source: { properties: Array<{ value: unknown }> } }>;
    return [exposure.exposure_config.properties[0]!.value, metrics[0]!.source.properties[0]!.value];
  }

  it("hashes a cohort reference by key, not by the cohort's contents", () => {
    const edited = cohort({ ...internal, filters: { properties: { type: "AND", values: [] } } });
    expect(experimentHash(excluding(internal))).toBe(experimentHash(excluding(edited)));
    expect(experimentHash(excluding(internal))).not.toBe(experimentHash(excluding(25969)));
  });

  it("sends the cohort's id on this project in exposure criteria and metrics", () => {
    const ctx = newApplyContext();
    ctx.cohortIdByKey.set("internal-users", 2);
    expect(cohortValues(buildCreatePayload(excluding(internal), "h", ctx))).toEqual([2, 2]);
  });

  it("leaves experiments without references untouched", () => {
    const plain = spec("plain", { metrics: [{ kind: "ExperimentMetric", metric_type: "mean" }] });
    expect(resolveCohortRefs(plain, newApplyContext()).metrics).toBe(plain.metrics);
  });

  it("throws when the cohort has no known id", () => {
    expect(() => resolveCohortRefs(excluding(internal), newApplyContext())).toThrow(
      /references cohort "internal-users" but no server id is known/,
    );
  });

  it("rejects a literal cohort id", () => {
    const issues = validateExperiments([excluding(25969)], desiredFor({ experiments: [] }));
    expect(issues).toEqual([
      'experiment "jev" filters on cohort 25969 by id, which differs between projects — use the cohort\'s spec as the value',
      'experiment "jev" filters on cohort 25969 by id, which differs between projects — use the cohort\'s spec as the value',
    ]);
  });

  it("flags references to cohorts that aren't declared", () => {
    const declared = desiredFor({ experiments: [], cohorts: [internal] });
    expect(validateExperiments([excluding(internal)], declared)).toEqual([]);
    const other = desiredFor({ experiments: [], cohorts: [cohort({ key: "other", name: "Other", is_static: true })] });
    expect(validateExperiments([excluding(internal)], other)).toContain(
      'experiment "jev" references unknown cohort "internal-users" — declare it with cohort({ key: "internal-users", … })',
    );
  });

  function planFor(serverCohortId: number, cohorts: Array<{ id: number; key: string }>): string {
    const desired = excluding(internal);
    const onServer = excluding(serverCohortId);
    const server = serverRow(1, "jev", experimentHash(desired), {
      status: "running",
      metrics: onServer.metrics as ServerExperiment["metrics"],
      exposure_criteria: onServer.exposure_criteria,
    });
    const current = currentFor([server]);
    current.set(
      "cohorts",
      cohorts.map(
        ({ id, key }) =>
          ({ id, name: key, description: `<!-- iac:cohorts:${key} iac:hash:h -->` }) as ServerCohort,
      ),
    );
    return diff(desiredFor({ experiments: [desired], cohorts: [internal] }), current).get("experiments")!
      .ops[0]!.kind;
  }

  it("keeps an experiment unchanged while it filters on its cohort's id on this project", () => {
    expect(planFor(2, [{ id: 2, key: "internal-users" }])).toBe("unchanged");
  });

  it("updates an experiment that still filters on another project's cohort id", () => {
    expect(planFor(25969, [{ id: 2, key: "internal-users" }])).toBe("update");
  });

  it("updates an experiment whose cohort doesn't exist on this project yet", () => {
    expect(planFor(2, [])).toBe("update");
  });

  it("shows cohort references by key on both sides of the plan", () => {
    const ctx = newApplyContext();
    ctx.cohortKeyByServerId.set(2, "internal-users");
    const onServer = excluding(2);
    const server = serverRow(1, "jev", "h", {
      metrics: onServer.metrics as ServerExperiment["metrics"],
      exposure_criteria: onServer.exposure_criteria,
    });
    const pick = (display: unknown) => JSON.stringify(display).match(/\{[^{}]*internal-users[^{}]*\}/g);
    expect(pick(displayExperimentFromServer(server, ctx))).toEqual(pick(displayExperiment(excluding(internal))));
    expect(pick(displayExperiment(excluding(internal)))).toHaveLength(2);
  });
});
