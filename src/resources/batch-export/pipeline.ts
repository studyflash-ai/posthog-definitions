import type { ClientConfig } from "../../client/config.js";
import { ApiError } from "../../client/typed.js";
import { specHash } from "../../apply/hash.js";
import { displayJson, obj, scalar, type DisplayValue } from "../../apply/display.js";
import { SafetyViolationError } from "../../apply/errors.js";
import { getResourceKind, type ApplyContext, type ResourceOp } from "../types.js";
import type { BatchExport } from "./sdk.js";
import {
  type BatchExportCreate,
  createBatchExport,
  deleteBatchExport,
  getBatchExport,
  type ServerBatchExport,
  updateBatchExport,
} from "./client.js";

/**
 * Batch exports have no `tags` and no `description`; `name` is the only
 * free-form text the API round-trips. Identity and hash are appended to it as
 * a trailing marker:
 *
 *     <user name> [iac:batch-exports:<key> iac:hash:<hex>]
 *
 * The marker must be the last content of the name. A name without it is
 * invisible to the CLI (safety invariant).
 */
export const BATCH_EXPORT_IDENTITY_PREFIX = "iac:batch-exports:";

const MARKER_REGEX = /\s*\[iac:batch-exports:(\S+) iac:hash:([0-9a-f]+)\]$/;

const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

type ParsedMarker = {
  /** Name with the trailing marker removed. */
  userName: string;
  key: string;
  hash: string;
};

function parseMarker(name: string): ParsedMarker | undefined {
  const match = name.match(MARKER_REGEX);
  if (!match || match.index === undefined) return undefined;
  return { userName: name.slice(0, match.index), key: match[1]!, hash: match[2]! };
}

export function withMarker(userName: string, key: string, hash: string): string {
  return `${userName.trim()} [${BATCH_EXPORT_IDENTITY_PREFIX}${key} iac:hash:${hash}]`;
}

export function stripMarker(name: string): string {
  return parseMarker(name)?.userName ?? name;
}

export function batchExportKeyFromServer(server: ServerBatchExport): string | undefined {
  return parseMarker(server.name)?.key;
}

export function batchExportHashFromServer(server: ServerBatchExport): string | undefined {
  return parseMarker(server.name)?.hash;
}

/** Null config values are server defaults, not user-authored settings. */
function withoutNulls(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([, v]) => v !== null));
}

function batchExportSpecForHash(spec: BatchExport): unknown {
  return {
    key: spec.key,
    name: spec.name,
    model: spec.model,
    interval: spec.interval,
    paused: spec.paused ?? false,
    destination: {
      type: spec.destination.type,
      integration_id: spec.destination.integration_id,
      config: withoutNulls(spec.destination.config),
    },
  };
}

export function batchExportHash(spec: BatchExport): string {
  return specHash(batchExportSpecForHash(spec));
}

export function batchExportPayload(spec: BatchExport, hash: string): BatchExportCreate {
  return {
    name: withMarker(spec.name, spec.key, hash),
    model: spec.model,
    interval: spec.interval,
    paused: spec.paused ?? false,
    destination: {
      type: spec.destination.type,
      integration_id: spec.destination.integration_id,
      config: spec.destination.config,
    },
  };
}

export function looksLikeBatchExport(value: unknown): value is BatchExport {
  return getResourceKind(value) === "batch-export";
}

export function validateBatchExports(specs: BatchExport[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (!spec.key) {
      issues.push("batch-export.key is required");
      continue;
    }
    if (!KEY_PATTERN.test(spec.key)) {
      issues.push(`batch export "${spec.key}" key must match /^[a-zA-Z0-9_-]+$/`);
    }
    if (seen.has(spec.key)) issues.push(`Duplicate batch export key "${spec.key}"`);
    seen.add(spec.key);

    if (!spec.name || spec.name.trim() === "") {
      issues.push(`batch export "${spec.key}" name is required`);
    } else if (spec.name.includes(`[${BATCH_EXPORT_IDENTITY_PREFIX}`)) {
      issues.push(`batch export "${spec.key}" name must not contain the iac marker`);
    }
    if (!spec.destination?.type) {
      issues.push(`batch export "${spec.key}" destination.type is required`);
    }
    if (!Number.isInteger(spec.destination?.integration_id)) {
      issues.push(`batch export "${spec.key}" destination.integration_id is required`);
    }
  }
  return issues;
}

async function assertManagedBatchExport(
  config: ClientConfig,
  id: string,
  key: string,
  options: { verbose?: boolean },
): Promise<void> {
  const current = await getBatchExport(config, id, options);
  if (batchExportKeyFromServer(current) !== key) {
    throw new SafetyViolationError("batch export", id, key);
  }
}

export async function runBatchExportOp(
  config: ClientConfig,
  op: ResourceOp<BatchExport, ServerBatchExport>,
  _ctx: ApplyContext,
  options: { verbose?: boolean } = {},
): Promise<void> {
  if (op.kind === "unchanged") return;

  const payload = batchExportPayload(op.spec, batchExportHash(op.spec));

  if (op.kind === "create") {
    await createBatchExport(config, payload, options);
    return;
  }

  await assertManagedBatchExport(config, op.server.id, op.spec.key, options);
  await updateBatchExport(config, op.server.id, payload, options);
}

export async function pruneBatchExport(
  config: ClientConfig,
  orphan: ServerBatchExport,
  options: { verbose?: boolean } = {},
): Promise<boolean> {
  const key = batchExportKeyFromServer(orphan) ?? `id:${orphan.id}`;
  try {
    await assertManagedBatchExport(config, orphan.id, key, options);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false;
    throw err;
  }
  await deleteBatchExport(config, orphan.id, options);
  return true;
}

function batchExportDisplayFields(values: {
  name: string;
  model: string | null;
  interval: string;
  paused: boolean;
  destination: unknown;
}): DisplayValue {
  return obj([
    ["name", scalar(values.name)],
    ["model", scalar(values.model)],
    ["interval", scalar(values.interval)],
    ["paused", scalar(values.paused)],
    ["destination", displayJson(values.destination)],
  ]);
}

export function displayBatchExport(spec: BatchExport): DisplayValue {
  return batchExportDisplayFields({
    name: spec.name,
    model: spec.model,
    interval: spec.interval,
    paused: spec.paused ?? false,
    destination: {
      type: spec.destination.type,
      integration_id: spec.destination.integration_id,
      config: withoutNulls(spec.destination.config),
    },
  });
}

export function displayBatchExportFromServer(server: ServerBatchExport): DisplayValue {
  return batchExportDisplayFields({
    name: stripMarker(server.name),
    model: server.model ?? null,
    interval: server.interval,
    paused: server.paused,
    destination: {
      type: server.destination.type,
      integration_id: server.destination.integration_id ?? server.destination.integration ?? null,
      config: withoutNulls(server.destination.config),
    },
  });
}
