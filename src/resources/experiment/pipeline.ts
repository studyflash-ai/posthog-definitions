import type { ClientConfig } from "../../client/config.js";
import { ApiError } from "../../client/typed.js";
import { specHash } from "../../apply/hash.js";
import { arr, displayJson, obj, scalar, type DisplayValue } from "../../apply/display.js";
import { SafetyViolationError } from "../../apply/errors.js";
import { getResourceKind, type ApplyContext, type DesiredState, type ResourceOp } from "../types.js";
import type { ServerCohort } from "../cohort/client.js";
import { cohortKeyFromServer } from "../cohort/pipeline.js";
import { cohortFilterValues, isCohortSpec, mapCohortFilters } from "../cohort/refs.js";
import type { Cohort } from "../cohort/sdk.js";
import type { ExperimentHoldout } from "../experiment-holdout/sdk.js";
import type { ExperimentSavedMetric } from "../experiment-saved-metric/sdk.js";
import type { FeatureFlag } from "../feature-flag/sdk.js";
import type { Experiment, ExperimentLifecycle } from "./sdk.js";
import {
  archiveExperiment,
  createExperiment,
  deleteExperiment,
  endExperiment,
  type ExperimentCreate,
  type ExperimentUpdate,
  getExperiment,
  launchExperiment,
  pauseExperiment,
  resumeExperiment,
  type SavedMetricRef,
  type ServerExperiment,
  unarchiveExperiment,
  updateExperiment,
} from "./client.js";

/**
 * Experiment has no `tags` field. Identity sits in a trailing HTML-comment
 * marker on `description` (same pattern as endpoints / holdouts / saved metrics).
 */
export const EXPERIMENT_IDENTITY_PREFIX = "iac:experiments:";

const MARKER_REGEX = /\n*<!--\s*iac:experiments:(\S+)\s+iac:hash:(\S+)\s*-->\s*$/;
const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

type ParsedMarker = { userDescription: string; key: string; hash: string };

function parseMarker(description: string | null | undefined): ParsedMarker | undefined {
  if (!description) return undefined;
  const match = description.match(MARKER_REGEX);
  if (!match || match.index === undefined) return undefined;
  return {
    userDescription: description.slice(0, match.index).replace(/\s+$/, ""),
    key: match[1]!,
    hash: match[2]!,
  };
}

function withMarker(userDescription: string | undefined, key: string, hash: string): string {
  const trailer = `<!-- iac:experiments:${key} iac:hash:${hash} -->`;
  const trimmed = (userDescription ?? "").replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${trailer}` : trailer;
}

export function stripMarker(description: string | null | undefined): string | null {
  if (!description) return null;
  const parsed = parseMarker(description);
  return parsed ? parsed.userDescription || null : description;
}

export function experimentKeyFromServer(server: ServerExperiment): string | undefined {
  return parseMarker(server.description)?.key;
}

export function experimentHashFromServer(server: ServerExperiment): string | undefined {
  return parseMarker(server.description)?.hash;
}

function desiredLifecycle(spec: Experiment): ExperimentLifecycle {
  return spec.lifecycle ?? "draft";
}

function currentLifecycle(server: ServerExperiment): ExperimentLifecycle {
  // The server returns `status` as the computed lifecycle; we trust it. Without one, the dates say it.
  return server.status ?? (server.end_date ? "stopped" : server.start_date ? "running" : "draft");
}

type FilterFields = Pick<Experiment, "metrics" | "metrics_secondary" | "exposure_criteria">;

/** The fields that can hold `type: "cohort"` filters, with each filter's value rewritten. */
function mapFilterFields(spec: Experiment, replace: (value: unknown) => unknown): FilterFields {
  return {
    metrics: mapCohortFilters(spec.metrics, replace) as FilterFields["metrics"],
    metrics_secondary: mapCohortFilters(spec.metrics_secondary, replace) as FilterFields["metrics_secondary"],
    exposure_criteria: mapCohortFilters(spec.exposure_criteria, replace) as FilterFields["exposure_criteria"],
  };
}

function specCohortFilterValues(spec: FilterFields): unknown[] {
  return [spec.metrics, spec.metrics_secondary, spec.exposure_criteria].flatMap(cohortFilterValues);
}

/** Filters with cohort references by key, so the hash and the plan are the same on every project. */
function filtersByCohortKey(spec: Experiment): FilterFields {
  return mapFilterFields(spec, (value) => (isCohortSpec(value) ? { cohort: value.key } : value));
}

export function resolveCohortRefs(spec: Experiment, ctx: ApplyContext): FilterFields {
  return mapFilterFields(spec, (value) => {
    if (!isCohortSpec(value)) return value;
    const id = ctx.cohortIdByKey.get(value.key);
    if (id === undefined) {
      throw new Error(
        `experiment "${spec.key}" references cohort "${value.key}" but no server id is known. Cohorts must run before experiments.`,
      );
    }
    return id;
  });
}

/** Whether the server's experiment filters on other cohorts than the spec's references point at on this project. */
export function experimentCohortRefsStale(
  spec: Experiment,
  server: ServerExperiment,
  cohorts: ServerCohort[],
): boolean {
  if (!specCohortFilterValues(spec).some(isCohortSpec)) return false;
  const idByKey = new Map<string, number>();
  for (const row of cohorts) {
    const key = cohortKeyFromServer(row);
    if (key) idByKey.set(key, row.id);
  }
  const wanted = mapFilterFields(spec, (value) =>
    isCohortSpec(value) ? (idByKey.get(value.key) ?? null) : value,
  );
  const values = (fields: FilterFields) => specCohortFilterValues(fields).map(String).sort();
  return JSON.stringify(values(wanted)) !== JSON.stringify(values(server as FilterFields));
}

function specForHash(spec: Experiment): unknown {
  // Everything that round-trips, EXCLUDING server-resolved ids and managed marker.
  // Cross-resource references are hashed by KEY, not server id, so the hash is
  // environment-portable.
  const filters = filtersByCohortKey(spec);
  return {
    key: spec.key,
    name: spec.name,
    description: spec.description ?? "",
    type: spec.type ?? null,
    lifecycle: desiredLifecycle(spec),
    archived: spec.archived ?? false,
    feature_flag_key: spec.featureFlag.key,
    holdout_key: spec.holdout?.key ?? null,
    parameters: spec.parameters ?? null,
    metrics: filters.metrics ?? [],
    metrics_secondary: filters.metrics_secondary ?? [],
    exposure_criteria: filters.exposure_criteria ?? null,
    primary_saved_metric_keys: (spec.primarySavedMetrics ?? []).map((m) => m.key),
    secondary_saved_metric_keys: (spec.secondarySavedMetrics ?? []).map((m) => m.key),
    conclusion: spec.conclusion ?? null,
    conclusion_comment: spec.conclusionComment ?? null,
  };
}

export function experimentHash(spec: Experiment): string {
  return specHash(specForHash(spec));
}

function resolveHoldoutId(spec: Experiment, ctx: ApplyContext): number | null | undefined {
  if (!spec.holdout) return null;
  const id = ctx.experimentHoldoutIdByKey.get(spec.holdout.key);
  if (id === undefined) {
    throw new Error(
      `experiment "${spec.key}" references holdout "${spec.holdout.key}" but no server id is known. Holdouts must run before experiments.`,
    );
  }
  return id;
}

function resolveSavedMetricIds(spec: Experiment, ctx: ApplyContext): SavedMetricRef[] {
  const refs: SavedMetricRef[] = [];
  for (const metric of spec.primarySavedMetrics ?? []) {
    const id = ctx.experimentSavedMetricIdByKey.get(metric.key);
    if (id === undefined) {
      throw new Error(
        `experiment "${spec.key}" references saved metric "${metric.key}" but no server id is known. Saved metrics must run before experiments.`,
      );
    }
    refs.push({ id, metadata: { type: "primary" } });
  }
  for (const metric of spec.secondarySavedMetrics ?? []) {
    const id = ctx.experimentSavedMetricIdByKey.get(metric.key);
    if (id === undefined) {
      throw new Error(
        `experiment "${spec.key}" references saved metric "${metric.key}" but no server id is known. Saved metrics must run before experiments.`,
      );
    }
    refs.push({ id, metadata: { type: "secondary" } });
  }
  return refs;
}

/** `parameters` keys the server keeps on the flag itself; it rejects them when creating against an existing flag. */
const FLAG_CONFIG_PARAMETER_KEYS: readonly string[] = [
  "feature_flag_variants",
  "rollout_percentage",
  "aggregation_group_type_index",
  "feature_flag_payloads",
  "ensure_experience_continuity",
];

/** Build the create payload (used only for the initial POST). */
export function buildCreatePayload(spec: Experiment, hash: string, ctx: ApplyContext): ExperimentCreate {
  const holdoutId = resolveHoldoutId(spec, ctx);
  const savedMetrics = resolveSavedMetricIds(spec, ctx);
  const filters = resolveCohortRefs(spec, ctx);
  const payload: ExperimentCreate = {
    name: spec.name,
    description: withMarker(spec.description, spec.key, hash),
    feature_flag_key: spec.featureFlag.key,
  };
  if (spec.type !== undefined) payload.type = spec.type;
  // Feature flags apply before experiments, so the flag always exists here and the server links it as-is.
  const parameters = Object.fromEntries(
    Object.entries(spec.parameters ?? {}).filter(([key]) => !FLAG_CONFIG_PARAMETER_KEYS.includes(key)),
  );
  if (Object.keys(parameters).length > 0) payload.parameters = parameters;
  if (filters.metrics !== undefined) payload.metrics = filters.metrics;
  if (filters.metrics_secondary !== undefined) payload.metrics_secondary = filters.metrics_secondary;
  if (filters.exposure_criteria !== undefined) payload.exposure_criteria = filters.exposure_criteria;
  if (holdoutId !== undefined) payload.holdout_id = holdoutId;
  if (savedMetrics.length > 0) payload.saved_metrics_ids = savedMetrics;
  if (spec.conclusion !== undefined) payload.conclusion = spec.conclusion;
  if (spec.conclusionComment !== undefined) payload.conclusion_comment = spec.conclusionComment;
  // A start date launches the experiment as it is created, backdated; with an end date it lands
  // stopped. Neither is in the hash or the patch body, so existing experiments keep their dates.
  if (spec.startDate !== undefined) payload.start_date = spec.startDate;
  if (spec.endDate !== undefined) payload.end_date = spec.endDate;
  // `archived` is reached via the archive/unarchive actions, not the PATCH body.
  return payload;
}

/** Build the patch payload — feature_flag_key is omitted (immutable post-create). */
function buildUpdatePayload(spec: Experiment, hash: string, ctx: ApplyContext): ExperimentUpdate {
  const holdoutId = resolveHoldoutId(spec, ctx);
  const savedMetrics = resolveSavedMetricIds(spec, ctx);
  const filters = resolveCohortRefs(spec, ctx);
  const payload: ExperimentUpdate = {
    name: spec.name,
    description: withMarker(spec.description, spec.key, hash),
  };
  if (spec.type !== undefined) payload.type = spec.type;
  if (spec.parameters !== undefined) payload.parameters = spec.parameters as Record<string, unknown>;
  if (filters.metrics !== undefined) payload.metrics = filters.metrics;
  if (filters.metrics_secondary !== undefined) payload.metrics_secondary = filters.metrics_secondary;
  if (filters.exposure_criteria !== undefined) payload.exposure_criteria = filters.exposure_criteria;
  if (holdoutId !== undefined) payload.holdout_id = holdoutId;
  payload.saved_metrics_ids = savedMetrics;
  if (spec.conclusion !== undefined) payload.conclusion = spec.conclusion;
  if (spec.conclusionComment !== undefined) payload.conclusion_comment = spec.conclusionComment;
  return payload;
}

export function looksLikeExperiment(value: unknown): value is Experiment {
  return getResourceKind(value) === "experiment";
}

/**
 * Allowed lifecycle transitions, applied AFTER the create/update of the
 * experiment row. Keyed by current state. Anything not listed is a no-op or
 * rejected at validate.
 */
const ALLOWED_TRANSITIONS: Record<ExperimentLifecycle, readonly ExperimentLifecycle[]> = {
  draft: ["draft", "running", "paused"],
  running: ["running", "paused", "stopped"],
  paused: ["running", "paused", "stopped"],
  stopped: ["stopped"],
};

export function validateExperiments(
  specs: Experiment[],
  state: DesiredState,
): string[] {
  const issues: string[] = [];
  const seenKeys = new Set<string>();
  const seenNames = new Set<string>();

  const knownFlagKeys = new Set<string>();
  for (const loaded of state.get("feature-flags") ?? []) {
    const flag = loaded.spec as FeatureFlag;
    if (flag?.key) knownFlagKeys.add(flag.key);
  }
  const knownHoldoutKeys = new Set<string>();
  for (const loaded of state.get("experiment-holdouts") ?? []) {
    const h = loaded.spec as ExperimentHoldout;
    if (h?.key) knownHoldoutKeys.add(h.key);
  }
  const knownSavedMetricKeys = new Set<string>();
  for (const loaded of state.get("experiment-saved-metrics") ?? []) {
    const m = loaded.spec as ExperimentSavedMetric;
    if (m?.key) knownSavedMetricKeys.add(m.key);
  }
  const knownCohortKeys = new Set<string>();
  for (const loaded of state.get("cohorts") ?? []) {
    const c = loaded.spec as Cohort;
    if (c?.key) knownCohortKeys.add(c.key);
  }

  for (const spec of specs) {
    if (!spec.key) {
      issues.push("experiment.key is required");
      continue;
    }
    if (!KEY_PATTERN.test(spec.key)) {
      issues.push(`experiment "${spec.key}" key must match ${KEY_PATTERN.source}`);
    }
    if (seenKeys.has(spec.key)) {
      issues.push(`Duplicate experiment key "${spec.key}"`);
    }
    seenKeys.add(spec.key);
    if (!spec.name) {
      issues.push(`experiment "${spec.key}" name is required`);
    } else if (seenNames.has(spec.name)) {
      issues.push(`Duplicate experiment name "${spec.name}"`);
    } else {
      seenNames.add(spec.name);
    }
    if (!spec.featureFlag?.key) {
      issues.push(`experiment "${spec.key}" must reference a featureFlag`);
    } else if (!knownFlagKeys.has(spec.featureFlag.key)) {
      issues.push(
        `experiment "${spec.key}" references unknown feature flag "${spec.featureFlag.key}" — declare it with featureFlag({ key: "${spec.featureFlag.key}", … })`,
      );
    }
    if (spec.holdout && !knownHoldoutKeys.has(spec.holdout.key)) {
      issues.push(
        `experiment "${spec.key}" references unknown experiment holdout "${spec.holdout.key}"`,
      );
    }
    for (const m of spec.primarySavedMetrics ?? []) {
      if (!knownSavedMetricKeys.has(m.key)) {
        issues.push(
          `experiment "${spec.key}" references unknown experiment saved metric "${m.key}"`,
        );
      }
    }
    for (const m of spec.secondarySavedMetrics ?? []) {
      if (!knownSavedMetricKeys.has(m.key)) {
        issues.push(
          `experiment "${spec.key}" references unknown experiment saved metric "${m.key}"`,
        );
      }
    }
    for (const value of specCohortFilterValues(spec)) {
      if (!isCohortSpec(value)) {
        issues.push(
          `experiment "${spec.key}" filters on cohort ${JSON.stringify(value)} by id, which differs between projects — use the cohort's spec as the value`,
        );
      } else if (!knownCohortKeys.has(value.key)) {
        issues.push(
          `experiment "${spec.key}" references unknown cohort "${value.key}" — declare it with cohort({ key: "${value.key}", … })`,
        );
      }
    }

    const lifecycle = desiredLifecycle(spec);
    if (lifecycle === "stopped" && !spec.conclusion) {
      issues.push(
        `experiment "${spec.key}" lifecycle "stopped" requires a conclusion (won/lost/inconclusive/stopped_early/invalid)`,
      );
    }
    if (spec.archived && lifecycle !== "stopped") {
      issues.push(`experiment "${spec.key}" can only be archived once lifecycle is "stopped"`);
    }
    const start = spec.startDate === undefined ? undefined : Date.parse(spec.startDate);
    const end = spec.endDate === undefined ? undefined : Date.parse(spec.endDate);
    if (start !== undefined && (Number.isNaN(start) || lifecycle === "draft")) {
      issues.push(`experiment "${spec.key}" startDate must be an ISO 8601 timestamp on a launched experiment`);
    }
    if (end !== undefined && (Number.isNaN(end) || lifecycle !== "stopped" || start === undefined || end <= start)) {
      issues.push(`experiment "${spec.key}" endDate must be an ISO 8601 timestamp after startDate on a stopped experiment`);
    }

    // Multivariate split check, if variants are declared.
    const variants = spec.parameters?.feature_flag_variants;
    if (variants && variants.length > 0) {
      if (variants.length < 2) {
        issues.push(`experiment "${spec.key}" must declare at least 2 variants`);
      }
      const total = variants.reduce((sum, v) => sum + (v.rollout_percentage ?? 0), 0);
      if (total !== 100) {
        issues.push(
          `experiment "${spec.key}" variant rollout percentages sum to ${total}, must be 100`,
        );
      }
    }
  }
  return issues;
}

async function assertManaged(
  config: ClientConfig,
  id: number,
  key: string,
  options: { verbose?: boolean },
): Promise<void> {
  const current = await getExperiment(config, id, options);
  if (experimentKeyFromServer(current) !== key) {
    throw new SafetyViolationError("experiment", id, key);
  }
}

async function applyLifecycleTransition(
  config: ClientConfig,
  serverId: number,
  current: ExperimentLifecycle,
  desired: ExperimentLifecycle,
  conclusion: string | undefined,
  options: { verbose?: boolean },
): Promise<ServerExperiment | undefined> {
  if (current === desired) return undefined;
  const allowed = ALLOWED_TRANSITIONS[current];
  if (!allowed.includes(desired)) {
    throw new Error(
      `experiment ${serverId}: cannot transition from "${current}" to "${desired}". Allowed: ${allowed.join(", ")}.`,
    );
  }
  if (current === "draft" && desired === "running") {
    return launchExperiment(config, serverId, options);
  }
  if (current === "draft" && desired === "paused") {
    // launch, then pause
    await launchExperiment(config, serverId, options);
    return pauseExperiment(config, serverId, options);
  }
  if (current === "running" && desired === "paused") {
    return pauseExperiment(config, serverId, options);
  }
  if (current === "paused" && desired === "running") {
    return resumeExperiment(config, serverId, options);
  }
  if ((current === "running" || current === "paused") && desired === "stopped") {
    return endExperiment(config, serverId, conclusion ? { conclusion } : {}, options);
  }
  // Should be unreachable given ALLOWED_TRANSITIONS, but defend explicitly.
  throw new Error(
    `experiment ${serverId}: unhandled transition "${current}" → "${desired}".`,
  );
}

async function applyArchivedState(
  config: ClientConfig,
  serverId: number,
  currentArchived: boolean,
  desiredArchived: boolean,
  options: { verbose?: boolean },
): Promise<void> {
  if (currentArchived === desiredArchived) return;
  if (desiredArchived) await archiveExperiment(config, serverId, options);
  else await unarchiveExperiment(config, serverId, options);
}

export async function runExperimentOp(
  config: ClientConfig,
  op: ResourceOp<Experiment, ServerExperiment>,
  ctx: ApplyContext,
  options: { verbose?: boolean } = {},
): Promise<void> {
  if (op.kind === "unchanged") return;

  const desiredLc = desiredLifecycle(op.spec);
  const desiredArchived = op.spec.archived ?? false;

  const hash = experimentHash(op.spec);
  if (op.kind === "create") {
    // Created as a draft, or already launched (and ended) when the spec has dates. Lifecycle
    // transitions happen afterwards.
    const created = await createExperiment(
      config,
      buildCreatePayload(op.spec, hash, ctx),
      options,
    );
    await applyLifecycleTransition(
      config,
      created.id,
      currentLifecycle(created),
      desiredLc,
      op.spec.conclusion,
      options,
    );
    await applyArchivedState(config, created.id, false, desiredArchived, options);
    return;
  }

  // Update path.
  await assertManaged(config, op.server.id, op.spec.key, options);
  const updated = await updateExperiment(
    config,
    op.server.id,
    buildUpdatePayload(op.spec, hash, ctx),
    options,
  );
  await applyLifecycleTransition(
    config,
    updated.id,
    currentLifecycle(updated),
    desiredLc,
    op.spec.conclusion,
    options,
  );
  await applyArchivedState(config, updated.id, updated.archived ?? false, desiredArchived, options);
}

export async function pruneExperiment(
  config: ClientConfig,
  orphan: ServerExperiment,
  options: { verbose?: boolean } = {},
): Promise<boolean> {
  const key = experimentKeyFromServer(orphan) ?? `id:${orphan.id}`;
  try {
    await assertManaged(config, orphan.id, key, options);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false;
    throw err;
  }
  await deleteExperiment(config, orphan.id, options);
  return true;
}

export function displayExperiment(spec: Experiment): DisplayValue {
  const filters = filtersByCohortKey(spec);
  return obj([
    ["key", scalar(spec.key)],
    ["name", scalar(spec.name)],
    ["description", scalar(spec.description ?? null)],
    ["type", scalar(spec.type ?? null)],
    ["lifecycle", scalar(desiredLifecycle(spec))],
    ["archived", scalar(spec.archived ?? false)],
    ["feature_flag", scalar(spec.featureFlag.key)],
    ["holdout", scalar(spec.holdout?.key ?? null)],
    ["parameters", displayJson(spec.parameters ?? null)],
    ["metrics", arr((filters.metrics ?? []).map(displayJson))],
    ["metrics_secondary", arr((filters.metrics_secondary ?? []).map(displayJson))],
    ["exposure_criteria", displayJson(filters.exposure_criteria ?? null)],
    [
      "primary_saved_metrics",
      arr((spec.primarySavedMetrics ?? []).map((m) => scalar(m.key))),
    ],
    [
      "secondary_saved_metrics",
      arr((spec.secondarySavedMetrics ?? []).map((m) => scalar(m.key))),
    ],
    ["conclusion", scalar(spec.conclusion ?? null)],
    ["conclusion_comment", scalar(spec.conclusionComment ?? null)],
  ]);
}

/** Server bodies with known cohort ids shown as keys, matching how the spec side displays them. */
function serverByCohortKey(value: unknown, ctx?: ApplyContext): unknown {
  if (!ctx || ctx.cohortKeyByServerId.size === 0) return value;
  return mapCohortFilters(value, (filterValue) => {
    if (typeof filterValue !== "number") return filterValue;
    const key = ctx.cohortKeyByServerId.get(filterValue);
    return key ? { cohort: key } : filterValue;
  });
}

export function displayExperimentFromServer(server: ServerExperiment, ctx?: ApplyContext): DisplayValue {
  return obj([
    ["key", scalar(experimentKeyFromServer(server) ?? null)],
    ["name", scalar(server.name)],
    ["description", scalar(stripMarker(server.description))],
    ["type", scalar(server.type ?? null)],
    ["lifecycle", scalar(server.status ?? "draft")],
    ["archived", scalar(server.archived)],
    ["feature_flag", scalar(server.feature_flag_key)],
    ["holdout", scalar(server.holdout_id ?? null)],
    ["parameters", displayJson(server.parameters ?? null)],
    ["metrics", arr((server.metrics ?? []).map((m) => displayJson(serverByCohortKey(m, ctx))))],
    [
      "metrics_secondary",
      arr((server.metrics_secondary ?? []).map((m) => displayJson(serverByCohortKey(m, ctx)))),
    ],
    ["exposure_criteria", displayJson(serverByCohortKey(server.exposure_criteria ?? null, ctx))],
    [
      "saved_metrics",
      arr((server.saved_metrics ?? []).map((m) => displayJson(m))),
    ],
    ["conclusion", scalar(server.conclusion ?? null)],
    ["conclusion_comment", scalar(server.conclusion_comment ?? null)],
  ]);
}
