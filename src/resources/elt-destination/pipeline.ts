import type { ClientConfig } from "../../client/config.js";
import { ApiError } from "../../client/typed.js";
import { specHash } from "../../apply/hash.js";
import { arr, displayJson, obj, scalar, type DisplayValue } from "../../apply/display.js";
import { SafetyViolationError } from "../../apply/errors.js";
import {
  getResourceKind,
  type ApplyContext,
  type DesiredState,
  type ResourceOp,
} from "../types.js";
import { getExternalDataSource } from "../external-data-source/client.js";
import {
  externalDataSourceAdoptionKeyFromServer,
  externalDataSourceKeyFromServer,
  looksLikeExternalDataSource,
} from "../external-data-source/pipeline.js";
import type { ExternalDataSource } from "../external-data-source/sdk.js";
import type { EltDestination, EltDestinationTable } from "./sdk.js";
import {
  createEltDestination,
  deleteEltDestination,
  getEltDestination,
  getSchemaDestinations,
  type ServerEltDestination,
  setSchemaDestinations,
  updateEltDestination,
} from "./client.js";

/**
 * Destinations have no `tags` or `description`, so identity and hash ride in a
 * trailing marker on `name`, as for batch exports:
 *
 *     <user name> [iac:elt-destinations:<key> iac:hash:<hex>]
 *
 * A destination without the marker is invisible to the CLI.
 */
export const ELT_DESTINATION_IDENTITY_PREFIX = "iac:elt-destinations:";

const MARKER_REGEX = /\s*\[iac:elt-destinations:(\S+) iac:hash:([0-9a-f]+)\]$/;

const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

const NAME_MAX_LENGTH = 400;

const TYPES = new Set([
  "Postgres",
  "Redshift",
  "Snowflake",
  "BigQuery",
  "Databricks",
  "S3",
  "AzureBlob",
]);

type ParsedMarker = { userName: string; key: string; hash: string };

function parseMarker(name: string): ParsedMarker | undefined {
  const match = name.match(MARKER_REGEX);
  if (!match || match.index === undefined) return undefined;
  return { userName: name.slice(0, match.index), key: match[1]!, hash: match[2]! };
}

export function withMarker(userName: string, key: string, hash: string): string {
  return `${userName.trim()} [${ELT_DESTINATION_IDENTITY_PREFIX}${key} iac:hash:${hash}]`;
}

export function stripMarker(name: string): string {
  return parseMarker(name)?.userName ?? name;
}

export function eltDestinationKeyFromServer(server: ServerEltDestination): string | undefined {
  return parseMarker(server.name)?.key;
}

export function eltDestinationHashFromServer(server: ServerEltDestination): string | undefined {
  return parseMarker(server.name)?.hash;
}

function tableLabel(table: EltDestinationTable): string {
  return `${table.source.key}/${table.schema}`;
}

export function eltDestinationHash(spec: EltDestination): string {
  return specHash({
    key: spec.key,
    name: spec.name,
    type: spec.type,
    integration_id: spec.integration_id,
    config: spec.config,
    tables: spec.tables.map(tableLabel).sort(),
  });
}

export function looksLikeEltDestination(value: unknown): value is EltDestination {
  return getResourceKind(value) === "elt-destination";
}

export function validateEltDestinations(specs: EltDestination[], state: DesiredState): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const sources = new Map<string, ExternalDataSource>();
  for (const loaded of state.get("external-data-sources") ?? []) {
    if (looksLikeExternalDataSource(loaded.spec)) sources.set(loaded.spec.key, loaded.spec);
  }
  for (const spec of specs) {
    if (!spec.key) {
      issues.push("elt-destination.key is required");
      continue;
    }
    const label = `ELT destination "${spec.key}"`;
    if (!KEY_PATTERN.test(spec.key)) issues.push(`${label} key must match /^[a-zA-Z0-9_-]+$/`);
    if (seen.has(spec.key)) issues.push(`Duplicate ELT destination key "${spec.key}"`);
    seen.add(spec.key);

    if (!spec.name || spec.name.trim() === "") {
      issues.push(`${label} name is required`);
    } else if (spec.name.includes(`[${ELT_DESTINATION_IDENTITY_PREFIX}`)) {
      issues.push(`${label} name must not contain the iac marker`);
    } else if (withMarker(spec.name, spec.key, "0".repeat(16)).length > NAME_MAX_LENGTH) {
      issues.push(`${label} name is too long to hold the iac marker`);
    }
    if (!TYPES.has(spec.type))
      issues.push(`${label} type "${spec.type}" is not a destination type`);
    if (!Number.isInteger(spec.integration_id) || spec.integration_id <= 0) {
      issues.push(`${label} integration_id is required`);
    }

    const seenTables = new Set<string>();
    for (const table of spec.tables) {
      const source = sources.get(table.source?.key);
      if (!source) {
        issues.push(`${label} table ${tableLabel(table)} names a source that isn't declared`);
        continue;
      }
      if (!source.schemas.some((schema) => schema.name === table.schema)) {
        issues.push(`${label} table ${tableLabel(table)} isn't in that source's schemas`);
      }
      if (seenTables.has(tableLabel(table)))
        issues.push(`${label} lists ${tableLabel(table)} twice`);
      seenTables.add(tableLabel(table));
    }
  }
  return issues;
}

async function assertManagedDestination(
  config: ClientConfig,
  id: string,
  key: string,
  options: { verbose?: boolean },
): Promise<void> {
  const current = await getEltDestination(config, id, options);
  if (eltDestinationKeyFromServer(current) !== key) {
    throw new SafetyViolationError("ELT destination", id, key);
  }
}

/** A table's destination set as it is now, resolving inheritance from its source. */
async function currentSet(
  config: ClientConfig,
  schemaId: string,
  options: { verbose?: boolean },
): Promise<{ ids: string[]; overridden: boolean }> {
  const current = await getSchemaDestinations(config, schemaId, options);
  return current.inherits_from_source
    ? { ids: current.effective_destination_ids ?? [], overridden: false }
    : { ids: current.destination_ids ?? [], overridden: true };
}

/**
 * Add the destination to every declared table, keeping the table's other
 * destinations, then take it off the tables that link it through their own
 * override but are no longer declared.
 */
async function reconcileTables(
  config: ClientConfig,
  spec: EltDestination,
  destinationId: string,
  ctx: ApplyContext,
  options: { verbose?: boolean },
): Promise<void> {
  const declaredSchemaIds = new Set<string>();
  for (const table of spec.tables) {
    const sourceId = ctx.externalDataSourceIdByKey.get(table.source.key);
    if (!sourceId) {
      throw new Error(
        `ELT destination "${spec.key}": source "${table.source.key}" wasn't applied first; apply external-data-sources with it`,
      );
    }
    const source = await getExternalDataSource(config, sourceId, options);
    const schema = (source.schemas ?? []).find((s) => s.name === table.schema);
    if (!schema) {
      throw new Error(
        `ELT destination "${spec.key}": source "${table.source.key}" has no table "${table.schema}"`,
      );
    }
    declaredSchemaIds.add(schema.id);
    const { ids } = await currentSet(config, schema.id, options);
    if (!ids.includes(destinationId)) {
      await setSchemaDestinations(config, schema.id, [...ids, destinationId], options);
    }
  }

  const destination = await getEltDestination(config, destinationId, options);
  for (const synced of destination.synced_sources ?? []) {
    if (!synced.via_table_override) continue;
    const source = await getExternalDataSource(config, synced.id, options);
    for (const schema of source.schemas ?? []) {
      if (declaredSchemaIds.has(schema.id)) continue;
      const { ids, overridden } = await currentSet(config, schema.id, options);
      if (!overridden || !ids.includes(destinationId)) continue;
      const rest = ids.filter((id) => id !== destinationId);
      await setSchemaDestinations(config, schema.id, rest.length > 0 ? rest : null, options);
    }
  }
}

export async function runEltDestinationOp(
  config: ClientConfig,
  op: ResourceOp<EltDestination, ServerEltDestination>,
  ctx: ApplyContext,
  options: { verbose?: boolean } = {},
): Promise<void> {
  if (op.kind === "unchanged") return;

  const spec = op.spec;
  const name = withMarker(spec.name, spec.key, eltDestinationHash(spec));

  if (op.kind === "create") {
    const id = await createEltDestination(
      config,
      { type: spec.type, name, config: spec.config, integration: spec.integration_id },
      options,
    );
    await reconcileTables(config, spec, id, ctx, options);
    return;
  }

  await assertManagedDestination(config, op.server.id, spec.key, options);
  // The integration and the target database and schema are fixed: the API rejects a change to them.
  await updateEltDestination(
    config,
    op.server.id,
    { name, config: spec.config, integration: spec.integration_id },
    options,
  );
  await reconcileTables(config, spec, op.server.id, ctx, options);
}

export async function pruneEltDestination(
  config: ClientConfig,
  orphan: ServerEltDestination,
  options: { verbose?: boolean } = {},
): Promise<boolean> {
  const key = eltDestinationKeyFromServer(orphan) ?? `id:${orphan.id}`;
  try {
    await assertManagedDestination(config, orphan.id, key, options);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false;
    throw err;
  }
  await deleteEltDestination(config, orphan.id, options);
  return true;
}

/**
 * The tables linked to a destination through their own override, as
 * `<source>/<table>`, where `<source>` is the source's spec key, or its type
 * and prefix when it isn't managed. Read for the plan, so a table someone
 * detached in PostHog shows as a change.
 */
export async function linkedTables(
  config: ClientConfig,
  server: ServerEltDestination,
  options: { verbose?: boolean } = {},
): Promise<string[]> {
  const labels: string[] = [];
  for (const synced of server.synced_sources ?? []) {
    if (!synced.via_table_override) continue;
    const source = await getExternalDataSource(config, synced.id, options);
    const sourceLabel =
      externalDataSourceKeyFromServer(source) ?? externalDataSourceAdoptionKeyFromServer(source);
    for (const schema of source.schemas ?? []) {
      const { ids, overridden } = await currentSet(config, schema.id, options);
      if (overridden && ids.includes(server.id)) labels.push(`${sourceLabel}/${schema.name}`);
    }
  }
  return labels.sort();
}

function destinationDisplayFields(values: {
  name: string;
  type: string;
  integration_id: number | null;
  config: unknown;
  tables: string[];
}): DisplayValue {
  return obj([
    ["name", scalar(values.name)],
    ["type", scalar(values.type)],
    ["integration_id", scalar(values.integration_id)],
    ["config", displayJson(values.config)],
    ["tables", arr(values.tables.map((table) => scalar(table)))],
  ]);
}

export function displayEltDestination(spec: EltDestination): DisplayValue {
  return destinationDisplayFields({
    name: spec.name,
    type: spec.type,
    integration_id: spec.integration_id,
    config: spec.config,
    tables: spec.tables.map(tableLabel).sort(),
  });
}

export function displayEltDestinationFromServer(server: ServerEltDestination): DisplayValue {
  return destinationDisplayFields({
    name: stripMarker(server.name),
    type: server.type,
    integration_id: server.integration ?? null,
    config: server.config ?? {},
    tables: server.linked_tables ?? [],
  });
}
