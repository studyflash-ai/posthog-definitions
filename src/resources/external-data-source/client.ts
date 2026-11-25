import { z } from "zod";
import type { ClientConfig } from "../../client/config.js";
import { requestJson } from "../../client/typed.js";

/**
 * Warehouse sources aren't in the generated OpenAPI types (see
 * openapi-filter.yaml), so these call the API through `requestJson` and parse
 * the answer here.
 */

export const ServerExternalDataSchemaSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    should_sync: z.boolean(),
    sync_type: z.string().nullable().optional(),
    sync_frequency: z.string().nullable().optional(),
    incremental_field: z.string().nullable().optional(),
    incremental_field_type: z.string().nullable().optional(),
  })
  .loose();

export type ServerExternalDataSchema = z.infer<typeof ServerExternalDataSchemaSchema>;

export const ServerExternalDataSourceSchema = z
  .object({
    id: z.string(),
    source_type: z.string(),
    prefix: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    job_inputs: z.record(z.string(), z.unknown()).nullable().optional(),
    schemas: z.array(ServerExternalDataSchemaSchema).optional(),
  })
  .loose();

export type ServerExternalDataSource = z.infer<typeof ServerExternalDataSourceSchema>;

const PageSchema = z.object({
  next: z.string().nullable().optional(),
  results: z.array(z.unknown()),
});

export type ExternalDataSourceCreate = {
  source_type: string;
  prefix: string;
  description: string;
  payload: Record<string, unknown>;
};

export type ExternalDataSchemaUpdate = {
  should_sync?: boolean;
  sync_type?: string;
  sync_frequency?: string;
  incremental_field?: string;
  incremental_field_type?: string;
};

function sourcesPath(config: ClientConfig): string {
  return `/api/projects/${config.projectId}/external_data_sources/`;
}

export async function listExternalDataSources(
  config: ClientConfig,
  options: { verbose?: boolean } = {},
): Promise<ServerExternalDataSource[]> {
  const rows: unknown[] = [];
  let path: string | null = `${sourcesPath(config)}?limit=100`;
  while (path) {
    const page = PageSchema.parse(await requestJson(config, "GET", path, undefined, options));
    rows.push(...page.results);
    path = page.next ? new URL(page.next).pathname + new URL(page.next).search : null;
  }
  return rows.map((row) => ServerExternalDataSourceSchema.parse(row));
}

export async function getExternalDataSource(
  config: ClientConfig,
  id: string,
  options: { verbose?: boolean } = {},
): Promise<ServerExternalDataSource> {
  return ServerExternalDataSourceSchema.parse(
    await requestJson(config, "GET", `${sourcesPath(config)}${id}/`, undefined, options),
  );
}

/** Returns the new source's id. */
export async function createExternalDataSource(
  config: ClientConfig,
  payload: ExternalDataSourceCreate,
  options: { verbose?: boolean } = {},
): Promise<string> {
  const created = z
    .object({ id: z.string() })
    .loose()
    .parse(await requestJson(config, "POST", sourcesPath(config), payload, options));
  return created.id;
}

export async function updateExternalDataSource(
  config: ClientConfig,
  id: string,
  payload: { description?: string; job_inputs?: Record<string, unknown> },
  options: { verbose?: boolean } = {},
): Promise<void> {
  await requestJson(config, "PATCH", `${sourcesPath(config)}${id}/`, payload, options);
}

/** Asks the source for tables it has gained since it was created. */
export async function refreshExternalDataSchemas(
  config: ClientConfig,
  id: string,
  options: { verbose?: boolean } = {},
): Promise<void> {
  await requestJson(config, "POST", `${sourcesPath(config)}${id}/refresh_schemas/`, {}, options);
}

export async function updateExternalDataSchema(
  config: ClientConfig,
  id: string,
  payload: ExternalDataSchemaUpdate,
  options: { verbose?: boolean } = {},
): Promise<void> {
  await requestJson(
    config,
    "PATCH",
    `/api/projects/${config.projectId}/external_data_schemas/${id}/`,
    payload,
    options,
  );
}
