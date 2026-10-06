import { specHash } from "../../apply/hash.js";
import { displayJson, obj, scalar } from "../../apply/display.js";
import { getResourceKind, type CollectionResourceModule } from "../types.js";
import type { BatchExport } from "./sdk.js";
import {
  createBatchExport,
  listBatchExports,
  type ServerBatchExport,
  updateBatchExport,
} from "./client.js";

export { batchExport } from "./sdk.js";
export type {
  BatchExport,
  BatchExportDestination,
  BatchExportInterval,
  BatchExportModel,
} from "./sdk.js";

/**
 * Batch exports are keyed by name and diffed by content: the hash is taken
 * over the same projection of the spec and of the live row, so a change made
 * in the UI shows up as drift. Every export in the project is listed, so
 * undeclared ones appear as orphans; prune never deletes them, because
 * nothing marks an export as managed.
 */
export const batchExportResource: CollectionResourceModule<BatchExport, ServerBatchExport> = {
  kind: "collection",
  name: "batch-exports",
  displayName: "batch export",
  identityPrefix: "name:",

  isSpec: (value): value is BatchExport => getResourceKind(value) === "batch-export",
  specKey: (spec) => spec.name,

  list: listBatchExports,
  keyFromServer: (server) => server.name,
  hashFromServer: (server) =>
    specHash(
      projection({
        model: server.model ?? "events",
        interval: server.interval,
        destination: server.destination,
      }),
    ),

  hash: (spec) => specHash(projection(spec)),
  validate: validateBatchExports,

  async executeOp(config, op) {
    if (op.kind === "create") await createBatchExport(config, op.spec);
    if (op.kind === "update") await updateBatchExport(config, op.server.id, op.spec);
  },
  prune: async () => false,

  displaySpec: (spec) => display(spec.name, projection(spec)),
  displayServer: (server) =>
    display(
      server.name,
      projection({
        model: server.model ?? "events",
        interval: server.interval,
        destination: server.destination,
      }),
    ),
};

function projection(e: {
  model: string;
  interval: string;
  destination: { type: string; integration?: number | null; config: Record<string, unknown> };
}): unknown {
  return {
    model: e.model,
    interval: e.interval,
    destination: {
      type: e.destination.type,
      integration: e.destination.integration ?? null,
      config: Object.fromEntries(
        Object.entries(e.destination.config).filter(([, v]) => v !== null && v !== undefined),
      ),
    },
  };
}

function display(name: string, projected: unknown) {
  return obj([
    ["name", scalar(name)],
    ["export", displayJson(projected)],
  ]);
}

function validateBatchExports(specs: BatchExport[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (!spec.name?.trim()) {
      issues.push("batch export name is required");
      continue;
    }
    if (seen.has(spec.name)) issues.push(`Duplicate batch export name "${spec.name}"`);
    seen.add(spec.name);
    if (!spec.destination?.type)
      issues.push(`batch export "${spec.name}" destination.type is required`);
  }
  return issues;
}
