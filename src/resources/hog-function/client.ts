import { z } from "zod";
import type { ClientConfig } from "../../client/config.js";
import type { components } from "../../generated/api.js";
import { createApiClient, followPagination, type Paginated } from "../../client/typed.js";

const MANAGED_DESCRIPTION_MARKER = "iac:hog-functions:";

export const ServerHogFunctionSchema = z
  .object({
    id: z.string(),
    type: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
    hog: z.string().nullable().optional(),
    inputs_schema: z.array(z.unknown()).nullable().optional(),
    inputs: z.record(z.string(), z.unknown()).nullable().optional(),
    filters: z.unknown().optional(),
    mappings: z.array(z.unknown()).nullable().optional(),
    masking: z.unknown().optional(),
  })
  .loose();

export type ServerHogFunction = z.infer<typeof ServerHogFunctionSchema>;

export type HogFunctionWrite = {
  type: string;
  name: string;
  description: string;
  enabled: boolean;
  template_id?: string;
  hog: string;
  inputs_schema: unknown[];
  inputs: Record<string, { value: unknown }>;
  filters?: Record<string, unknown>;
  mappings?: unknown[];
  masking?: Record<string, unknown> | null;
};

type HogFunctionBody = components["schemas"]["HogFunction"];
type PatchedHogFunctionBody = components["schemas"]["PatchedHogFunction"];
type GeneratedPaginatedList = components["schemas"]["PaginatedHogFunctionMinimalList"];

function paginatedFrom(raw: GeneratedPaginatedList): Paginated<unknown> {
  return {
    count: raw.count,
    next: raw.next ?? null,
    previous: raw.previous ?? null,
    results: raw.results ?? [],
  };
}

export async function listManagedHogFunctions(
  config: ClientConfig,
  options: { verbose?: boolean } = {},
): Promise<ServerHogFunction[]> {
  const all = await listHogFunctions(config, options);
  return all.filter((row) => row.description?.includes(MANAGED_DESCRIPTION_MARKER));
}

/** Every hog function in the project, managed or not. List rows omit inputs and mappings. */
export async function listHogFunctions(
  config: ClientConfig,
  options: { verbose?: boolean } = {},
): Promise<ServerHogFunction[]> {
  const api = createApiClient(config, { verbose: options.verbose });
  const { data } = await api.GET("/api/projects/{project_id}/hog_functions/", {
    params: { path: { project_id: config.projectId }, query: { limit: 100 } },
  });
  const firstPage = paginatedFrom(data!);
  const allRaw = await followPagination<unknown>(config, firstPage, { verbose: options.verbose });
  return allRaw.map((row) => ServerHogFunctionSchema.parse(row));
}

export async function getHogFunction(
  config: ClientConfig,
  id: string,
  options: { verbose?: boolean } = {},
): Promise<ServerHogFunction> {
  const api = createApiClient(config, { verbose: options.verbose });
  const { data } = await api.GET("/api/projects/{project_id}/hog_functions/{id}/", {
    params: { path: { project_id: config.projectId, id } },
  });
  return ServerHogFunctionSchema.parse(data);
}

export async function createHogFunction(
  config: ClientConfig,
  payload: HogFunctionWrite,
  options: { verbose?: boolean } = {},
): Promise<ServerHogFunction> {
  const api = createApiClient(config, { verbose: options.verbose });
  // The generated body marks server-computed fields (bytecode, status, …) as required.
  const { data } = await api.POST("/api/projects/{project_id}/hog_functions/", {
    params: { path: { project_id: config.projectId } },
    body: payload as unknown as HogFunctionBody,
  });
  return ServerHogFunctionSchema.parse(data);
}

export async function updateHogFunction(
  config: ClientConfig,
  id: string,
  payload: HogFunctionWrite | { deleted: true },
  options: { verbose?: boolean } = {},
): Promise<ServerHogFunction> {
  const api = createApiClient(config, { verbose: options.verbose });
  const { data } = await api.PATCH("/api/projects/{project_id}/hog_functions/{id}/", {
    params: { path: { project_id: config.projectId, id } },
    body: payload as unknown as PatchedHogFunctionBody,
  });
  return ServerHogFunctionSchema.parse(data);
}

/** Hog functions are soft-deleted, as in the UI. */
export async function deleteHogFunction(
  config: ClientConfig,
  id: string,
  options: { verbose?: boolean } = {},
): Promise<void> {
  await updateHogFunction(config, id, { deleted: true }, options);
}
