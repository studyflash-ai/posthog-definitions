import { z } from "zod";
import type { ClientConfig } from "../../client/config.js";
import type { components } from "../../generated/api.js";
import { createApiClient, followPagination, type Paginated } from "../../client/typed.js";

const MANAGED_NAME_MARKER = "[iac:batch-exports:";

export const ServerBatchExportSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    model: z.enum(["events", "persons", "sessions", "hogql", ""]).nullable().optional(),
    interval: z.string(),
    paused: z.boolean(),
    destination: z
      .object({
        type: z.string(),
        config: z.record(z.string(), z.unknown()),
        integration: z.number().nullable().optional(),
        integration_id: z.number().nullable().optional(),
      })
      .loose(),
    hogql_query: z.string().nullable().optional(),
    filters: z.unknown().optional(),
    timezone: z.string().nullable().optional(),
    offset_day: z.number().nullable().optional(),
    offset_hour: z.number().nullable().optional(),
    start_at: z.string().nullable().optional(),
    end_at: z.string().nullable().optional(),
  })
  .loose();

export type ServerBatchExport = z.infer<typeof ServerBatchExportSchema>;

export type BatchExportCreate = {
  name: string;
  model: string;
  interval: string;
  paused: boolean;
  destination: { type: string; integration_id: number; config: Record<string, unknown> };
};

export type BatchExportUpdate = Partial<BatchExportCreate>;

type BatchExportBody = components["schemas"]["BatchExportRequest"];
type PatchedBatchExportBody = components["schemas"]["PatchedBatchExportRequest"];
type GeneratedPaginatedBatchExportList = components["schemas"]["PaginatedBatchExportList"];

function paginatedFrom(raw: GeneratedPaginatedBatchExportList): Paginated<unknown> {
  return {
    count: raw.count,
    next: raw.next ?? null,
    previous: raw.previous ?? null,
    results: raw.results ?? [],
  };
}

export async function listManagedBatchExports(
  config: ClientConfig,
  options: { verbose?: boolean } = {},
): Promise<ServerBatchExport[]> {
  const all = await listBatchExports(config, options);
  return all.filter((row) => row.name.includes(MANAGED_NAME_MARKER));
}

/** Unfiltered list of every batch export in the project; used by pull. */
export async function listBatchExports(
  config: ClientConfig,
  options: { verbose?: boolean } = {},
): Promise<ServerBatchExport[]> {
  const api = createApiClient(config, { verbose: options.verbose });
  const { data } = await api.GET("/api/projects/{project_id}/batch_exports/", {
    params: {
      path: { project_id: config.projectId },
      query: { limit: 100 },
    },
  });
  const firstPage = paginatedFrom(data!);
  const allRaw = await followPagination<unknown>(config, firstPage, {
    verbose: options.verbose,
  });
  return allRaw.map((row) => ServerBatchExportSchema.parse(row));
}

export async function getBatchExport(
  config: ClientConfig,
  id: string,
  options: { verbose?: boolean } = {},
): Promise<ServerBatchExport> {
  const api = createApiClient(config, { verbose: options.verbose });
  const { data } = await api.GET("/api/projects/{project_id}/batch_exports/{id}/", {
    params: { path: { project_id: config.projectId, id } },
  });
  return ServerBatchExportSchema.parse(data);
}

export async function createBatchExport(
  config: ClientConfig,
  payload: BatchExportCreate,
  options: { verbose?: boolean } = {},
): Promise<ServerBatchExport> {
  const api = createApiClient(config, { verbose: options.verbose });
  // The generated request type omits the destination's `type` discriminator
  // (openapi-typescript applies `Omit<…, "type">` to the whole destination
  // union), but the API rejects destinations without it. Cast to bypass.
  const { data } = await api.POST("/api/projects/{project_id}/batch_exports/", {
    params: { path: { project_id: config.projectId } },
    body: payload as unknown as BatchExportBody,
  });
  return ServerBatchExportSchema.parse(data);
}

export async function updateBatchExport(
  config: ClientConfig,
  id: string,
  payload: BatchExportUpdate,
  options: { verbose?: boolean } = {},
): Promise<ServerBatchExport> {
  const api = createApiClient(config, { verbose: options.verbose });
  // Same missing `type` discriminator as createBatchExport.
  const { data } = await api.PATCH("/api/projects/{project_id}/batch_exports/{id}/", {
    params: { path: { project_id: config.projectId, id } },
    body: payload as unknown as PatchedBatchExportBody,
  });
  return ServerBatchExportSchema.parse(data);
}

export async function deleteBatchExport(
  config: ClientConfig,
  id: string,
  options: { verbose?: boolean } = {},
): Promise<void> {
  const api = createApiClient(config, { verbose: options.verbose });
  await api.DELETE("/api/projects/{project_id}/batch_exports/{id}/", {
    params: { path: { project_id: config.projectId, id } },
  });
}
