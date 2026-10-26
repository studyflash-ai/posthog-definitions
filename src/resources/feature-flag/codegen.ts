import type { ClientConfig } from "../../client/config.js";
import { isManagedTag } from "../../apply/display.js";
import {
  RawExpression,
  renderObject,
  renderRawLiteral,
  stringLiteral,
} from "../../pull/render.js";
import { slugify } from "../../pull/slug.js";
import type {
  ImportEntry,
  PullDependency,
  PullRenderContext,
  RenderedFile,
} from "../../pull/types.js";
import { type ServerFeatureFlag, updateFeatureFlag } from "./client.js";
import { featureFlagTag } from "./pipeline.js";
import type { FeatureFlag, FeatureFlagFilters, PropertyFilter } from "./sdk.js";

const HASH_TAG_PREFIX = "iac:hash:";

export function pullFilter(
  server: ServerFeatureFlag,
): { kept: true } | { kept: false; reason: string } {
  if (server.deleted) return { kept: false, reason: "deleted" };
  return { kept: true };
}

export function pullLabel(server: ServerFeatureFlag): { primary: string; secondary?: string } {
  const userTags = (server.tags ?? []).filter((t) => !isManagedTag(t));
  const secondary = userTags.length > 0 ? `[${userTags.join(", ")}]` : undefined;
  return { primary: server.name?.trim() || server.key, secondary };
}

export function serverIdOf(server: ServerFeatureFlag): number {
  return server.id;
}

function cohortProperties(filters: unknown): PropertyFilter[] {
  const f = filters as FeatureFlagFilters | null | undefined;
  const groups = [...(f?.groups ?? []), ...(f?.super_groups ?? [])];
  return groups
    .flatMap((group) => group.properties ?? [])
    .filter((property) => property.type === "cohort" && typeof property.value === "number");
}

/** Cohorts that release conditions target, so they get files and the flag can import them. */
export async function pullDependencies(
  _config: ClientConfig,
  server: ServerFeatureFlag,
): Promise<PullDependency[]> {
  const ids = new Set(cohortProperties(server.filters).map((p) => p.value as number));
  return [...ids].map((serverId) => ({ resourceName: "cohorts", serverId }));
}

/** Swaps each pulled cohort's id for its import; ids of cohorts that weren't pulled stay literal. */
function filtersWithCohortImports(
  server: ServerFeatureFlag,
  ctx: PullRenderContext,
  imports: Map<string, ImportEntry>,
): unknown {
  const swap = (property: PropertyFilter): PropertyFilter => {
    if (property.type !== "cohort" || typeof property.value !== "number") return property;
    const entry = ctx.importForServerIdOptional("cohorts", property.value);
    if (!entry) {
      ctx.warn(
        `Feature flag "${server.key}" targets cohort id=${property.value}, which wasn't pulled; it stays a literal id that only this project knows.`,
      );
      return property;
    }
    imports.set(entry.varName, entry);
    return { ...property, value: new RawExpression(entry.varName) };
  };
  const f = server.filters as FeatureFlagFilters | null | undefined;
  if (!f || cohortProperties(f).length === 0) return server.filters;
  const mapGroups = (groups: FeatureFlagFilters["groups"]) =>
    groups.map((group) => ({ ...group, properties: (group.properties ?? []).map(swap) }));
  return {
    ...f,
    groups: mapGroups(f.groups ?? []),
    ...(f.super_groups ? { super_groups: mapGroups(f.super_groups) } : {}),
  };
}

export function renderToFile(
  server: ServerFeatureFlag,
  ctx: PullRenderContext,
): RenderedFile | { skipped: true; reason: string } {
  const baseSlug = slugify(server.key) || slugify(server.name ?? "") || `flag-${server.id}`;
  const slug = ctx.uniqueSlug(baseSlug);

  const fields: Record<string, string> = {
    key: stringLiteral(server.key),
  };
  if (server.name) fields.name = stringLiteral(server.name);
  if (typeof server.active === "boolean") fields.active = String(server.active);

  const cohortImports = new Map<string, ImportEntry>();
  fields.filters = renderRawLiteral(filtersWithCohortImports(server, ctx, cohortImports), 2);

  if (server.ensure_experience_continuity)
    fields.ensure_experience_continuity = "true";
  if (server.is_remote_configuration)
    fields.is_remote_configuration = "true";
  if (server.evaluation_runtime && server.evaluation_runtime !== "all")
    fields.evaluation_runtime = stringLiteral(server.evaluation_runtime);
  if (server.bucketing_identifier && server.bucketing_identifier !== "distinct_id")
    fields.bucketing_identifier = stringLiteral(server.bucketing_identifier);

  const userTags = (server.tags ?? []).filter((t) => !isManagedTag(t));
  if (userTags.length > 0) fields.tags = `[${userTags.map(stringLiteral).join(", ")}]`;

  if (server.has_encrypted_payloads) {
    ctx.warn(
      `Feature flag "${server.key}" has has_encrypted_payloads=true. posthog-definitions doesn't manage encrypted payloads — review and edit manually.`,
    );
  }

  const body = renderObject(fields, 2);
  const importLines = [...cohortImports.values()].map(
    (entry) => `import ${entry.varName} from "../cohorts/${entry.filename.replace(/\.ts$/, ".js")}";\n`,
  );
  const contents =
    `import { featureFlag } from "@posthog/definitions";\n` +
    importLines.join("") +
    `\nexport default featureFlag(${body});\n`;
  return { filename: `${slug}.ts`, contents, specKey: server.key };
}

export async function tagOnServer(
  config: ClientConfig,
  server: ServerFeatureFlag,
  spec: FeatureFlag,
  hash: string,
  options: { verbose?: boolean } = {},
): Promise<void> {
  const userTags = (server.tags ?? []).filter((t) => !isManagedTag(t));
  await updateFeatureFlag(
    config,
    server.id,
    { tags: [featureFlagTag(spec.key), `${HASH_TAG_PREFIX}${hash}`, ...userTags] },
    options,
  );
}
