import { getResourceKind } from "../types.js";
import type { Cohort } from "./sdk.js";

type CohortFilter = Record<string, unknown> & { type: "cohort"; value: unknown };

function isCohortFilter(value: object): value is CohortFilter {
  return (value as Record<string, unknown>).type === "cohort" && "value" in value;
}

export function isCohortSpec(value: unknown): value is Cohort {
  return getResourceKind(value) === "cohort";
}

/**
 * Rewrites the value of every `type: "cohort"` filter nested anywhere in an
 * opaque body (experiment metrics, exposure criteria). Returns the same object
 * when nothing changes. Specs nested in the body are left as they are.
 */
export function mapCohortFilters(
  value: unknown,
  replace: (filterValue: unknown) => unknown,
): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const mapped = mapCohortFilters(item, replace);
      if (mapped !== item) changed = true;
      return mapped;
    });
    return changed ? next : value;
  }
  if (typeof value !== "object" || value === null || getResourceKind(value) !== undefined)
    return value;
  if (isCohortFilter(value)) {
    const replaced = replace(value.value);
    return replaced === value.value ? value : { ...value, value: replaced };
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const mapped = mapCohortFilters(child, replace);
    if (mapped !== child) changed = true;
    next[key] = mapped;
  }
  return changed ? next : value;
}

/** The value of every `type: "cohort"` filter nested anywhere in an opaque body. */
export function cohortFilterValues(value: unknown): unknown[] {
  const found: unknown[] = [];
  mapCohortFilters(value, (filterValue) => {
    found.push(filterValue);
    return filterValue;
  });
  return found;
}
