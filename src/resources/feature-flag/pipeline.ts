import type { ClientConfig } from "../../client/config.js";
import { ApiError } from "../../client/typed.js";
import { specHash } from "../../apply/hash.js";
import {
  arr,
  displayJson,
  filterUserTags,
  obj,
  scalar,
  type DisplayValue,
} from "../../apply/display.js";
import { SafetyViolationError } from "../../apply/errors.js";
import type { Cohort } from "../cohort/sdk.js";
import {
  getResourceKind,
  type ApplyContext,
  type DesiredState,
  type ResourceOp,
} from "../types.js";
import type {
  FeatureFlag,
  FeatureFlagFilters,
  PropertyFilter,
  ReleaseConditionGroup,
} from "./sdk.js";
import {
  createFeatureFlag,
  deleteFeatureFlag,
  type FeatureFlagCreate,
  getFeatureFlag,
  type ServerFeatureFlag,
  updateFeatureFlag,
} from "./client.js";

export const FEATURE_FLAG_TAG_PREFIX = "iac:feature-flags:";
export const HASH_TAG_PREFIX = "iac:hash:";

const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function featureFlagTag(key: string): string {
  return `${FEATURE_FLAG_TAG_PREFIX}${key}`;
}

export function featureFlagKeyFromTags(tags: string[] | undefined): string | undefined {
  const tag = tags?.find((t) => t.startsWith(FEATURE_FLAG_TAG_PREFIX));
  return tag?.slice(FEATURE_FLAG_TAG_PREFIX.length);
}

export function featureFlagHashFromTags(tags: string[] | undefined): string | undefined {
  return tags?.find((t) => t.startsWith(HASH_TAG_PREFIX))?.slice(HASH_TAG_PREFIX.length);
}

function hashTag(hex: string): string {
  return `${HASH_TAG_PREFIX}${hex}`;
}

function mergeTags(userTags: string[] | undefined, managedTags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of managedTags) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  for (const tag of userTags ?? []) {
    if (tag.startsWith("iac:")) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

function cohortRef(property: PropertyFilter): Cohort | undefined {
  if (property.type !== "cohort" || getResourceKind(property.value) !== "cohort") return undefined;
  return property.value as Cohort;
}

/** Rewrites each `cohort()` reference in the filters; returns the same object when there are none. */
function mapCohortRefs(
  filters: FeatureFlagFilters,
  replace: (cohort: Cohort) => unknown,
): FeatureFlagFilters {
  if (!collectPropertyFilters(filters).some((p) => cohortRef(p))) return filters;
  const mapGroup = (group: ReleaseConditionGroup): ReleaseConditionGroup =>
    group.properties
      ? {
          ...group,
          properties: group.properties.map((property) => {
            const cohort = cohortRef(property);
            return cohort ? { ...property, value: replace(cohort) } : property;
          }),
        }
      : group;
  return {
    ...filters,
    groups: filters.groups.map(mapGroup),
    ...(filters.super_groups ? { super_groups: filters.super_groups.map(mapGroup) } : {}),
  };
}

/** Filters with cohort references by key, so the hash is the same on every project. */
function filtersByCohortKey(filters: FeatureFlagFilters): FeatureFlagFilters {
  return mapCohortRefs(filters, (cohort) => ({ cohort: cohort.key }));
}

export function resolveCohortRefs(spec: FeatureFlag, ctx: ApplyContext): FeatureFlagFilters {
  return mapCohortRefs(spec.filters, (cohort) => {
    const id = ctx.cohortIdByKey.get(cohort.key);
    if (id === undefined) {
      throw new Error(
        `feature flag "${spec.key}" references cohort "${cohort.key}" but no server id is known. Cohorts must run before feature flags.`,
      );
    }
    return id;
  });
}

export function featureFlagPayload(
  spec: FeatureFlag,
  hash: string,
  filters: FeatureFlagFilters = spec.filters,
): FeatureFlagCreate {
  const payload: FeatureFlagCreate = {
    key: spec.key,
    name: spec.name ?? "",
    filters: filters as unknown as Record<string, unknown>,
    active: spec.active ?? true,
    tags: mergeTags(spec.tags, [featureFlagTag(spec.key), hashTag(hash)]),
  };
  if (spec.ensure_experience_continuity !== undefined) {
    payload.ensure_experience_continuity = spec.ensure_experience_continuity;
  }
  if (spec.is_remote_configuration !== undefined) {
    payload.is_remote_configuration = spec.is_remote_configuration;
  }
  if (spec.has_encrypted_payloads !== undefined) {
    payload.has_encrypted_payloads = spec.has_encrypted_payloads;
  }
  if (spec.evaluation_runtime !== undefined) {
    payload.evaluation_runtime = spec.evaluation_runtime;
  }
  if (spec.bucketing_identifier !== undefined) {
    payload.bucketing_identifier = spec.bucketing_identifier;
  }
  return payload;
}

function featureFlagSpecForHash(spec: FeatureFlag): unknown {
  return {
    key: spec.key,
    name: spec.name ?? "",
    active: spec.active ?? true,
    filters: filtersByCohortKey(spec.filters),
    ensure_experience_continuity: spec.ensure_experience_continuity ?? false,
    is_remote_configuration: spec.is_remote_configuration ?? false,
    has_encrypted_payloads: spec.has_encrypted_payloads ?? false,
    evaluation_runtime: spec.evaluation_runtime ?? "all",
    bucketing_identifier: spec.bucketing_identifier ?? "distinct_id",
    tags: filterUserTags(spec.tags),
  };
}

export function featureFlagHash(spec: FeatureFlag): string {
  return specHash(featureFlagSpecForHash(spec));
}

export function looksLikeFeatureFlag(value: unknown): value is FeatureFlag {
  return getResourceKind(value) === "feature-flag";
}

function collectPropertyFilters(filters: FeatureFlagFilters): PropertyFilter[] {
  const all: PropertyFilter[] = [];
  for (const group of filters.groups ?? []) {
    for (const property of group.properties ?? []) all.push(property);
  }
  for (const group of filters.super_groups ?? []) {
    for (const property of group.properties ?? []) all.push(property);
  }
  return all;
}

export function validateFeatureFlags(specs: FeatureFlag[], state?: DesiredState): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const knownCohortKeys = new Set<string>();
  for (const loaded of state?.get("cohorts") ?? []) {
    const cohort = loaded.spec as Cohort;
    if (cohort?.key) knownCohortKeys.add(cohort.key);
  }
  for (const spec of specs) {
    if (!spec.key) {
      issues.push("featureFlag.key is required");
      continue;
    }
    if (!KEY_PATTERN.test(spec.key)) {
      issues.push(`feature flag "${spec.key}" key must match /^[a-zA-Z0-9_-]+$/`);
    }
    if (seen.has(spec.key)) {
      issues.push(`Duplicate feature flag key "${spec.key}"`);
    }
    seen.add(spec.key);

    if (!spec.filters || !Array.isArray(spec.filters.groups)) {
      issues.push(`feature flag "${spec.key}" is missing filters.groups`);
      continue;
    }

    if (spec.filters.multivariate) {
      const variants = spec.filters.multivariate.variants ?? [];
      if (variants.length === 0) {
        issues.push(`feature flag "${spec.key}" multivariate has no variants`);
      } else {
        const total = variants.reduce((sum, v) => sum + (v.rollout_percentage ?? 0), 0);
        if (total !== 100) {
          issues.push(
            `feature flag "${spec.key}" multivariate variant rollout_percentage sums to ${total}, must be 100`,
          );
        }
      }
    }

    if (spec.has_encrypted_payloads) {
      issues.push(
        `feature flag "${spec.key}" has_encrypted_payloads is not yet supported by posthog-definitions`,
      );
    }

    for (const property of collectPropertyFilters(spec.filters)) {
      if (property.type === "flag") {
        issues.push(
          `feature flag "${spec.key}" references another flag via type:"flag" properties; dependent flags are not yet supported by posthog-definitions`,
        );
        break;
      }
    }

    for (const property of collectPropertyFilters(spec.filters)) {
      const cohort = cohortRef(property);
      if (cohort && !knownCohortKeys.has(cohort.key)) {
        issues.push(
          `feature flag "${spec.key}" references unknown cohort "${cohort.key}" — declare it with cohort({ key: "${cohort.key}", … })`,
        );
      }
    }
  }
  return issues;
}

async function assertManagedFeatureFlag(
  config: ClientConfig,
  id: number,
  key: string,
  options: { verbose?: boolean },
): Promise<void> {
  const current = await getFeatureFlag(config, id, options);
  if (!current.tags?.includes(featureFlagTag(key))) {
    throw new SafetyViolationError("feature flag", id, key);
  }
}

export async function runFeatureFlagOp(
  config: ClientConfig,
  op: ResourceOp<FeatureFlag, ServerFeatureFlag>,
  ctx: ApplyContext,
  options: { verbose?: boolean } = {},
): Promise<void> {
  if (op.kind === "unchanged") return;

  const payload = featureFlagPayload(
    op.spec,
    featureFlagHash(op.spec),
    resolveCohortRefs(op.spec, ctx),
  );

  if (op.kind === "create") {
    await createFeatureFlag(config, payload, options);
    return;
  }

  await assertManagedFeatureFlag(config, op.server.id, op.spec.key, options);
  await updateFeatureFlag(config, op.server.id, payload, options);
}

export async function pruneFeatureFlag(
  config: ClientConfig,
  orphan: ServerFeatureFlag,
  options: { verbose?: boolean } = {},
): Promise<boolean> {
  const key = featureFlagKeyFromTags(orphan.tags) ?? `id:${orphan.id}`;
  try {
    await assertManagedFeatureFlag(config, orphan.id, key, options);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false;
    throw err;
  }
  await deleteFeatureFlag(config, orphan.id, options);
  return true;
}

export function displayFeatureFlag(spec: FeatureFlag): DisplayValue {
  return obj([
    ["key", scalar(spec.key)],
    ["name", scalar(spec.name ?? "")],
    ["active", scalar(spec.active ?? true)],
    ["filters", displayJson(filtersByCohortKey(spec.filters))],
    ["ensure_experience_continuity", scalar(spec.ensure_experience_continuity ?? false)],
    ["is_remote_configuration", scalar(spec.is_remote_configuration ?? false)],
    ["evaluation_runtime", scalar(spec.evaluation_runtime ?? "all")],
    ["bucketing_identifier", scalar(spec.bucketing_identifier ?? "distinct_id")],
    ["tags", arr(filterUserTags(spec.tags).map(scalar))],
  ]);
}

/** Server filters with known cohort ids shown as keys, matching how the spec side displays them. */
function serverFiltersByCohortKey(filters: unknown, ctx?: ApplyContext): unknown {
  if (!ctx || ctx.cohortKeyByServerId.size === 0) return filters;
  const f = filters as FeatureFlagFilters | null | undefined;
  if (!f || !Array.isArray(f.groups)) return filters;
  const mapGroup = (group: ReleaseConditionGroup): ReleaseConditionGroup => ({
    ...group,
    properties: (group.properties ?? []).map((property) => {
      if (property.type !== "cohort" || typeof property.value !== "number") return property;
      const key = ctx.cohortKeyByServerId.get(property.value);
      return key ? { ...property, value: { cohort: key } } : property;
    }),
  });
  return {
    ...f,
    groups: f.groups.map(mapGroup),
    ...(f.super_groups ? { super_groups: f.super_groups.map(mapGroup) } : {}),
  };
}

export function displayFeatureFlagFromServer(
  server: ServerFeatureFlag,
  ctx?: ApplyContext,
): DisplayValue {
  return obj([
    ["key", scalar(server.key)],
    ["name", scalar(server.name ?? "")],
    ["active", scalar(server.active)],
    ["filters", displayJson(serverFiltersByCohortKey(server.filters, ctx))],
    ["ensure_experience_continuity", scalar(server.ensure_experience_continuity ?? false)],
    ["is_remote_configuration", scalar(server.is_remote_configuration ?? false)],
    ["evaluation_runtime", scalar(server.evaluation_runtime ?? "all")],
    ["bucketing_identifier", scalar(server.bucketing_identifier ?? "distinct_id")],
    ["tags", arr(filterUserTags(server.tags).map(scalar))],
  ]);
}
