import { z } from "zod";
import type { ClientConfig } from "../../client/config.js";
import { ApiError, followPagination, type Paginated } from "../../client/typed.js";
import type { BatchExport } from "./sdk.js";

export const ServerBatchExportSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    model: z.string().nullable().optional(),
    interval: z.string(),
    paused: z.boolean().optional(),
    destination: z
      .object({
        type: z.string(),
        integration: z.number().nullable().optional(),
        config: z.record(z.string(), z.unknown()).default({}),
      })
      .loose(),
  })
  .loose();

export type ServerBatchExport = z.infer<typeof ServerBatchExportSchema>;

// The trimmed OpenAPI client doesn't carry batch exports (regenerating it pulls
// in unrelated upstream schema changes), so these calls go through fetch.
async function request(
  config: ClientConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${config.host}/api/projects/${config.projectId}/batch_exports/${path}`;
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new ApiError(response.status, method, url, await response.text(), undefined);
  return response.status === 204 ? undefined : response.json();
}

export async function listBatchExports(
  config: ClientConfig,
  options: { verbose?: boolean } = {},
): Promise<ServerBatchExport[]> {
  const first = (await request(config, "GET", "?limit=100")) as Paginated<unknown>;
  const rows = await followPagination(config, first, options);
  return rows.map((row) => ServerBatchExportSchema.parse(row));
}

export async function createBatchExport(config: ClientConfig, spec: BatchExport): Promise<void> {
  await request(config, "POST", "", spec);
}

export async function updateBatchExport(
  config: ClientConfig,
  id: string,
  spec: BatchExport,
): Promise<void> {
  await request(config, "PATCH", `${id}/`, spec);
}
