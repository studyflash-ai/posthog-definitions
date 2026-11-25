import { z } from "zod";
import type { ClientConfig } from "../../client/config.js";
import { requestJson } from "../../client/typed.js";

/**
 * ELT destinations aren't in the generated OpenAPI types (see
 * openapi-filter.yaml), so these call the API through `requestJson` and parse
 * the answer here.
 */

export const ServerEltDestinationSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    name: z.string(),
    config: z.record(z.string(), z.unknown()).nullable().optional(),
    integration: z.number().nullable().optional(),
    is_posthog_warehouse: z.boolean().optional(),
    synced_sources: z
      .array(
        z.object({ id: z.string(), name: z.string(), via_table_override: z.boolean() }).loose(),
      )
      .optional(),
    /** Filled in by the CLI, not the API: `<source>/<table>` for each table linked through its own override. */
    linked_tables: z.array(z.string()).optional(),
  })
  .loose();

export type ServerEltDestination = z.infer<typeof ServerEltDestinationSchema>;

export const SchemaDestinationsSchema = z
  .object({
    destination_ids: z.array(z.string()).nullable(),
    inherits_from_source: z.boolean(),
    effective_destination_ids: z.array(z.string()).optional(),
  })
  .loose();

export type SchemaDestinations = z.infer<typeof SchemaDestinationsSchema>;

export type EltDestinationWrite = {
  type?: string;
  name?: string;
  config?: Record<string, unknown>;
  integration?: number;
};

const PageSchema = z.union([
  z.array(z.unknown()).transform((results) => ({ next: null, results })),
  z.object({ next: z.string().nullable().optional(), results: z.array(z.unknown()) }),
]);

function destinationsPath(config: ClientConfig): string {
  return `/api/projects/${config.projectId}/external_data_destinations/`;
}

function schemaDestinationsPath(config: ClientConfig, schemaId: string): string {
  return `/api/projects/${config.projectId}/external_data_schemas/${schemaId}/destinations/`;
}

export async function listEltDestinations(
  config: ClientConfig,
  options: { verbose?: boolean } = {},
): Promise<ServerEltDestination[]> {
  const rows: unknown[] = [];
  let path: string | null = `${destinationsPath(config)}?limit=100`;
  while (path) {
    const page = PageSchema.parse(await requestJson(config, "GET", path, undefined, options));
    rows.push(...page.results);
    path = page.next ? new URL(page.next).pathname + new URL(page.next).search : null;
  }
  return rows.map((row) => ServerEltDestinationSchema.parse(row));
}

export async function getEltDestination(
  config: ClientConfig,
  id: string,
  options: { verbose?: boolean } = {},
): Promise<ServerEltDestination> {
  return ServerEltDestinationSchema.parse(
    await requestJson(config, "GET", `${destinationsPath(config)}${id}/`, undefined, options),
  );
}

/** Returns the new destination's id. PostHog tests a Postgres connection before it creates one. */
export async function createEltDestination(
  config: ClientConfig,
  payload: Required<EltDestinationWrite>,
  options: { verbose?: boolean } = {},
): Promise<string> {
  return ServerEltDestinationSchema.parse(
    await requestJson(config, "POST", destinationsPath(config), payload, options),
  ).id;
}

export async function updateEltDestination(
  config: ClientConfig,
  id: string,
  payload: EltDestinationWrite,
  options: { verbose?: boolean } = {},
): Promise<void> {
  await requestJson(config, "PATCH", `${destinationsPath(config)}${id}/`, payload, options);
}

/** Soft-deletes the destination and detaches it from every source and table. */
export async function deleteEltDestination(
  config: ClientConfig,
  id: string,
  options: { verbose?: boolean } = {},
): Promise<void> {
  await requestJson(config, "DELETE", `${destinationsPath(config)}${id}/`, undefined, options);
}

export async function getSchemaDestinations(
  config: ClientConfig,
  schemaId: string,
  options: { verbose?: boolean } = {},
): Promise<SchemaDestinations> {
  return SchemaDestinationsSchema.parse(
    await requestJson(config, "GET", schemaDestinationsPath(config, schemaId), undefined, options),
  );
}

/** Replaces a table's own destinations; null clears them so the table follows its source again. */
export async function setSchemaDestinations(
  config: ClientConfig,
  schemaId: string,
  destinationIds: string[] | null,
  options: { verbose?: boolean } = {},
): Promise<void> {
  await requestJson(
    config,
    "PATCH",
    schemaDestinationsPath(config, schemaId),
    { destination_ids: destinationIds },
    options,
  );
}
