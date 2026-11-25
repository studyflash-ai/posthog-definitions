import { createHash } from "node:crypto";
import type { ClientConfig } from "../../client/config.js";
import { specHash } from "../../apply/hash.js";
import { arr, displayJson, obj, scalar, type DisplayValue } from "../../apply/display.js";
import { SafetyViolationError } from "../../apply/errors.js";
import { getResourceKind, type ApplyContext, type ResourceOp } from "../types.js";
import type { ExternalDataSchema, ExternalDataSource } from "./sdk.js";
import {
  createExternalDataSource,
  type ExternalDataSchemaUpdate,
  getExternalDataSource,
  refreshExternalDataSchemas,
  type ServerExternalDataSchema,
  type ServerExternalDataSource,
  updateExternalDataSchema,
  updateExternalDataSource,
} from "./client.js";

/**
 * Sources have no `tags`, and their `prefix` is fixed at creation, so identity
 * and hash ride in a trailing marker on `description`:
 *
 *     <user description> [iac:external-data-sources:<key> iac:hash:<hex>]
 *
 * A source without the marker is invisible to the CLI, except to the one spec
 * with the same type and prefix, which adopts it on its first apply.
 */
export const EXTERNAL_DATA_SOURCE_IDENTITY_PREFIX = "iac:external-data-sources:";

const MARKER_REGEX = /\s*\[iac:external-data-sources:(\S+) iac:hash:([0-9a-f]+)\]$/;

const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

const DESCRIPTION_MAX_LENGTH = 400;

const INCREMENTAL_SYNC_TYPES = new Set(["incremental", "append"]);

/** The API validates a sync type together with its incremental field, so they're sent together. */
const SYNC_FIELDS = ["sync_type", "incremental_field", "incremental_field_type"] as const;

type ParsedMarker = { userDescription: string; key: string; hash: string };

function parseMarker(description: string | null | undefined): ParsedMarker | undefined {
  if (!description) return undefined;
  const match = description.match(MARKER_REGEX);
  if (!match || match.index === undefined) return undefined;
  return { userDescription: description.slice(0, match.index), key: match[1]!, hash: match[2]! };
}

export function withMarker(userDescription: string, key: string, hash: string): string {
  const marker = `[${EXTERNAL_DATA_SOURCE_IDENTITY_PREFIX}${key} iac:hash:${hash}]`;
  const text = userDescription.trim();
  return text ? `${text} ${marker}` : marker;
}

export function stripMarker(description: string | null | undefined): string {
  return parseMarker(description)?.userDescription ?? description ?? "";
}

export function externalDataSourceKeyFromServer(
  server: ServerExternalDataSource,
): string | undefined {
  return parseMarker(server.description)?.key;
}

export function externalDataSourceHashFromServer(
  server: ServerExternalDataSource,
): string | undefined {
  return parseMarker(server.description)?.hash;
}

export function externalDataSourceAdoptionKey(spec: ExternalDataSource): string {
  return `${spec.source_type}:${spec.prefix ?? ""}`;
}

export function externalDataSourceAdoptionKeyFromServer(server: ServerExternalDataSource): string {
  return `${server.source_type}:${server.prefix ?? ""}`;
}

function secretDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Secrets go into the hash as digests, so rotating one in the environment
 * shows as an update and is sent on the next apply.
 */
export function externalDataSourceHash(spec: ExternalDataSource): string {
  return specHash({
    key: spec.key,
    source_type: spec.source_type,
    prefix: spec.prefix ?? "",
    description: spec.description ?? "",
    job_inputs: spec.job_inputs,
    secrets: Object.fromEntries(
      Object.entries(spec.secrets ?? {}).map(([name, value]) => [name, secretDigest(value)]),
    ),
    schemas: spec.schemas,
  });
}

export function looksLikeExternalDataSource(value: unknown): value is ExternalDataSource {
  return getResourceKind(value) === "external-data-source";
}

export function validateExternalDataSources(specs: ExternalDataSource[]): string[] {
  const issues: string[] = [];
  const seenKeys = new Set<string>();
  const seenIdentities = new Set<string>();
  for (const spec of specs) {
    if (!spec.key) {
      issues.push("external-data-source.key is required");
      continue;
    }
    const label = `external data source "${spec.key}"`;
    if (!KEY_PATTERN.test(spec.key)) issues.push(`${label} key must match /^[a-zA-Z0-9_-]+$/`);
    if (seenKeys.has(spec.key)) issues.push(`Duplicate external data source key "${spec.key}"`);
    seenKeys.add(spec.key);

    if (!spec.source_type) issues.push(`${label} source_type is required`);
    const identity = externalDataSourceAdoptionKey(spec);
    if (seenIdentities.has(identity)) {
      issues.push(`${label} has the same source_type and prefix as another source`);
    }
    seenIdentities.add(identity);

    const description = spec.description ?? "";
    if (description.includes(`[${EXTERNAL_DATA_SOURCE_IDENTITY_PREFIX}`)) {
      issues.push(`${label} description must not contain the iac marker`);
    }
    if (withMarker(description, spec.key, "0".repeat(16)).length > DESCRIPTION_MAX_LENGTH) {
      issues.push(`${label} description is too long to hold the iac marker`);
    }

    for (const name of Object.keys(spec.secrets ?? {})) {
      if (name in spec.job_inputs)
        issues.push(`${label} sets ${name} in both job_inputs and secrets`);
      if (!spec.secrets![name]) issues.push(`${label} secret ${name} is empty`);
    }

    if (spec.schemas.length === 0) issues.push(`${label} lists no schemas`);
    const seenSchemas = new Set<string>();
    for (const schema of spec.schemas) {
      if (seenSchemas.has(schema.name)) issues.push(`${label} lists schema "${schema.name}" twice`);
      seenSchemas.add(schema.name);
      if (INCREMENTAL_SYNC_TYPES.has(schema.sync_type) && !schema.incremental_field) {
        issues.push(
          `${label} schema "${schema.name}" needs an incremental_field for ${schema.sync_type}`,
        );
      }
    }
  }
  return issues;
}

function jobInputs(spec: ExternalDataSource): Record<string, unknown> {
  return { ...spec.job_inputs, ...spec.secrets };
}

function wantedSchemaFields(schema: ExternalDataSchema): ExternalDataSchemaUpdate {
  return {
    should_sync: true,
    sync_type: schema.sync_type,
    sync_frequency: schema.sync_frequency,
    ...(schema.incremental_field !== undefined && { incremental_field: schema.incremental_field }),
    ...(schema.incremental_field_type !== undefined && {
      incremental_field_type: schema.incremental_field_type,
    }),
  };
}

/** The fields of `schema` the server doesn't have yet. Empty when the table is as declared. */
export function schemaChanges(
  schema: ExternalDataSchema,
  server: ServerExternalDataSchema,
): ExternalDataSchemaUpdate {
  const wanted = wantedSchemaFields(schema);
  const changes: ExternalDataSchemaUpdate = {};
  for (const [field, value] of Object.entries(wanted)) {
    if (server[field] !== value) Object.assign(changes, { [field]: value });
  }
  if (SYNC_FIELDS.some((field) => field in changes)) {
    for (const field of SYNC_FIELDS) {
      if (wanted[field] !== undefined) Object.assign(changes, { [field]: wanted[field] });
    }
  }
  return changes;
}

async function reconcileSchemas(
  config: ClientConfig,
  spec: ExternalDataSource,
  id: string,
  options: { verbose?: boolean },
): Promise<void> {
  let server = await getExternalDataSource(config, id, options);
  const missing = (current: ServerExternalDataSource) =>
    spec.schemas.filter((schema) => !(current.schemas ?? []).some((s) => s.name === schema.name));
  if (missing(server).length > 0) {
    await refreshExternalDataSchemas(config, id, options);
    server = await getExternalDataSource(config, id, options);
  }
  const stillMissing = missing(server);
  if (stillMissing.length > 0) {
    throw new Error(
      `external data source "${spec.key}" has no table ${stillMissing.map((s) => `"${s.name}"`).join(", ")}`,
    );
  }
  for (const schema of spec.schemas) {
    const current = (server.schemas ?? []).find((s) => s.name === schema.name)!;
    const changes = schemaChanges(schema, current);
    if (Object.keys(changes).length > 0) {
      await updateExternalDataSchema(config, current.id, changes, options);
    }
  }
}

async function assertOwnedSource(
  config: ClientConfig,
  spec: ExternalDataSource,
  id: string,
  options: { verbose?: boolean },
): Promise<void> {
  const current = await getExternalDataSource(config, id, options);
  const key = externalDataSourceKeyFromServer(current);
  const adoptable =
    key === undefined &&
    externalDataSourceAdoptionKeyFromServer(current) === externalDataSourceAdoptionKey(spec);
  if (key !== spec.key && !adoptable) {
    throw new SafetyViolationError("external data source", id, spec.key);
  }
}

export async function runExternalDataSourceOp(
  config: ClientConfig,
  op: ResourceOp<ExternalDataSource, ServerExternalDataSource>,
  ctx: ApplyContext,
  options: { verbose?: boolean } = {},
): Promise<void> {
  if (op.kind === "unchanged") {
    ctx.externalDataSourceIdByKey.set(op.spec.key, op.server.id);
    return;
  }

  const spec = op.spec;
  const description = withMarker(spec.description ?? "", spec.key, externalDataSourceHash(spec));

  if (op.kind === "create") {
    // Created with only the declared tables syncing; frequencies are set per table afterwards,
    // as the API takes them there.
    const id = await createExternalDataSource(
      config,
      {
        source_type: spec.source_type,
        prefix: spec.prefix ?? "",
        description,
        payload: {
          ...jobInputs(spec),
          schemas: spec.schemas.map((schema) => {
            const { sync_frequency: _frequency, ...fields } = wantedSchemaFields(schema);
            return { name: schema.name, ...fields };
          }),
        },
      },
      options,
    );
    await reconcileSchemas(config, spec, id, options);
    ctx.externalDataSourceIdByKey.set(spec.key, id);
    return;
  }

  await assertOwnedSource(config, spec, op.server.id, options);
  await updateExternalDataSource(
    config,
    op.server.id,
    { description, job_inputs: jobInputs(spec) },
    options,
  );
  await reconcileSchemas(config, spec, op.server.id, options);
  ctx.externalDataSourceIdByKey.set(spec.key, op.server.id);
}

/**
 * Deleting a source deletes its tables and their synced data, so a source is
 * never pruned: delete it in PostHog once it's gone from the definitions.
 */
export async function pruneExternalDataSource(orphan: ServerExternalDataSource): Promise<boolean> {
  console.warn(
    `external data source ${orphan.id} (${externalDataSourceKeyFromServer(orphan)}) is no longer declared. ` +
      "Sources are never pruned, because deleting one deletes its synced tables: delete it in PostHog.",
  );
  return false;
}

function sourceDisplayFields(values: {
  source_type: string;
  prefix: string;
  description: string;
  job_inputs: unknown;
  secrets: string[];
  schemas: Array<Record<string, unknown>>;
}): DisplayValue {
  return obj([
    ["source_type", scalar(values.source_type)],
    ["prefix", scalar(values.prefix)],
    ["description", scalar(values.description)],
    ["job_inputs", displayJson(values.job_inputs)],
    ["secrets", arr(values.secrets.map((name) => scalar(`${name}: (secret)`)))],
    ["schemas", arr(values.schemas.map((schema) => displayJson(schema)))],
  ]);
}

export function displayExternalDataSource(spec: ExternalDataSource): DisplayValue {
  return sourceDisplayFields({
    source_type: spec.source_type,
    prefix: spec.prefix ?? "",
    description: spec.description ?? "",
    job_inputs: spec.job_inputs,
    secrets: Object.keys(spec.secrets ?? {}).sort(),
    schemas: spec.schemas.map((schema) => ({ name: schema.name, ...wantedSchemaFields(schema) })),
  });
}

/**
 * The server never returns secret job inputs, so secrets show as declared only on
 * the spec side. Only tables that sync are shown.
 */
export function displayExternalDataSourceFromServer(
  server: ServerExternalDataSource,
): DisplayValue {
  return sourceDisplayFields({
    source_type: server.source_type,
    prefix: server.prefix ?? "",
    description: stripMarker(server.description),
    job_inputs: server.job_inputs ?? {},
    secrets: [],
    schemas: (server.schemas ?? [])
      .filter((schema) => schema.should_sync)
      .map((schema) => ({
        name: schema.name,
        should_sync: schema.should_sync,
        sync_type: schema.sync_type,
        sync_frequency: schema.sync_frequency,
        ...(schema.incremental_field && { incremental_field: schema.incremental_field }),
        ...(schema.incremental_field_type && {
          incremental_field_type: schema.incremental_field_type,
        }),
      })),
  });
}
