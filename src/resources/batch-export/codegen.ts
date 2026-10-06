import type { ClientConfig } from "../../client/config.js";
import { renderObject, renderRawLiteral, stringLiteral } from "../../pull/render.js";
import { slugify } from "../../pull/slug.js";
import type { PullRenderContext, RenderedFile } from "../../pull/types.js";
import { type ServerBatchExport, updateBatchExport } from "./client.js";
import { stripMarker, withMarker } from "./pipeline.js";
import type { BatchExport } from "./sdk.js";

/**
 * Settings the API accepts but the `BatchExport` spec doesn't model yet. A row
 * that uses one can still be pulled, but apply won't manage the setting, so
 * the user is warned rather than having it silently dropped.
 */
const UNMODELED_FIELDS = [
  "hogql_query",
  "filters",
  "offset_day",
  "offset_hour",
  "start_at",
  "end_at",
] as const;

export function pullFilter(
  server: ServerBatchExport,
): { kept: true } | { kept: false; reason: string } {
  if (server.model === "hogql") return { kept: false, reason: "hogql-model" };
  if (server.destination.integration_id == null && server.destination.integration == null) {
    return { kept: false, reason: "no-integration" };
  }
  return { kept: true };
}

export function pullLabel(server: ServerBatchExport): { primary: string; secondary?: string } {
  const target = `${server.model ?? "events"} → ${server.destination.type}`;
  return {
    primary: stripMarker(server.name),
    secondary: server.paused ? `${target} [paused]` : target,
  };
}

export function serverIdOf(server: ServerBatchExport): string {
  return server.id;
}

export function renderToFile(
  server: ServerBatchExport,
  ctx: PullRenderContext,
): RenderedFile | { skipped: true; reason: string } {
  const name = stripMarker(server.name);
  const baseSlug = slugify(name) || `batch-export-${server.id}`;
  const slug = ctx.uniqueSlug(baseSlug);

  for (const field of UNMODELED_FIELDS) {
    const value = server[field];
    if (value !== null && value !== undefined) {
      ctx.warn(`Batch export "${slug}" sets ${field}, which apply doesn't manage yet.`);
    }
  }
  if (server.timezone && server.timezone !== "UTC") {
    ctx.warn(
      `Batch export "${slug}" uses timezone ${server.timezone}, which apply doesn't manage yet.`,
    );
  }

  const config = Object.fromEntries(
    Object.entries(server.destination.config).filter(([, v]) => v !== null),
  );
  const fields: Record<string, string> = {
    key: stringLiteral(slug),
    name: stringLiteral(name),
    model: stringLiteral(server.model || "events"),
    interval: stringLiteral(server.interval),
    destination: renderRawLiteral(
      {
        type: server.destination.type,
        integration_id: server.destination.integration_id ?? server.destination.integration,
        config,
      },
      4,
    ),
  };
  if (server.paused) fields.paused = "true";

  const body = renderObject(fields, 2);
  const contents =
    `import { batchExport } from "@posthog/definitions";\n\n` +
    `export default batchExport(${body});\n`;
  return { filename: `${slug}.ts`, contents, specKey: slug };
}

export async function tagOnServer(
  config: ClientConfig,
  server: ServerBatchExport,
  spec: BatchExport,
  hash: string,
  options: { verbose?: boolean } = {},
): Promise<void> {
  await updateBatchExport(
    config,
    server.id,
    { name: withMarker(stripMarker(server.name), spec.key, hash) },
    options,
  );
}
