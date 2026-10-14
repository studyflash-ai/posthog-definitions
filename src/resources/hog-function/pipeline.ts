import type { ClientConfig } from "../../client/config.js";
import { ApiError } from "../../client/typed.js";
import { specHash } from "../../apply/hash.js";
import { displayJson, obj, scalar, type DisplayValue } from "../../apply/display.js";
import { SafetyViolationError } from "../../apply/errors.js";
import { getResourceKind, type ApplyContext, type ResourceOp } from "../types.js";
import type { HogFunction, HogFunctionMapping } from "./sdk.js";
import {
  createHogFunction,
  deleteHogFunction,
  getHogFunction,
  type HogFunctionWrite,
  type ServerHogFunction,
  updateHogFunction,
} from "./client.js";

/**
 * Hog functions have no `tags`, so identity and hash are embedded in the
 * `description` as a trailing HTML comment, as for endpoints:
 *
 *     <user description>
 *
 *     <!-- iac:hog-functions:<key> iac:hash:<hex> -->
 *
 * A description without this marker is invisible to the CLI (safety invariant).
 */
export const HOG_FUNCTION_IDENTITY_PREFIX = "iac:hog-functions:";

const MARKER_REGEX = /\n*<!--\s*iac:hog-functions:(\S+)\s+iac:hash:(\S+)\s*-->\s*$/;

const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

const SECRET_PLACEHOLDER = "<secret>";

type ParsedMarker = { userDescription: string; key: string; hash: string };

function parseMarker(description: string | null | undefined): ParsedMarker | undefined {
  if (!description) return undefined;
  const match = description.match(MARKER_REGEX);
  if (!match || match.index === undefined) return undefined;
  return {
    userDescription: description.slice(0, match.index).replace(/\s+$/, ""),
    key: match[1]!,
    hash: match[2]!,
  };
}

export function withMarker(userDescription: string | undefined, key: string, hash: string): string {
  const trailer = `<!-- ${HOG_FUNCTION_IDENTITY_PREFIX}${key} iac:hash:${hash} -->`;
  const trimmed = (userDescription ?? "").replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${trailer}` : trailer;
}

export function stripMarker(description: string | null | undefined): string | null {
  if (!description) return null;
  const parsed = parseMarker(description);
  return parsed ? parsed.userDescription || null : description;
}

export function hogFunctionKeyFromServer(server: ServerHogFunction): string | undefined {
  return parseMarker(server.description)?.key;
}

export function hogFunctionHashFromServer(server: ServerHogFunction): string | undefined {
  return parseMarker(server.description)?.hash;
}

function hogFunctionSpecForHash(spec: HogFunction): unknown {
  return {
    key: spec.key,
    type: spec.type,
    name: spec.name,
    description: spec.description ?? null,
    enabled: spec.enabled ?? true,
    template_id: spec.template_id ?? null,
    hog: spec.hog,
    inputs_schema: spec.inputs_schema,
    inputs: spec.inputs ?? {},
    secret_inputs: Object.keys(spec.secret_inputs ?? {}).sort(),
    filters: spec.filters ?? null,
    mappings: spec.mappings ?? null,
    masking: spec.masking ?? null,
  };
}

export function hogFunctionHash(spec: HogFunction): string {
  return specHash(hogFunctionSpecForHash(spec));
}

function wrapInputs(
  values: Record<string, unknown> | undefined,
): Record<string, { value: unknown }> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, { value }]));
}

function mappingPayload(mapping: HogFunctionMapping): unknown {
  return {
    name: mapping.name,
    ...(mapping.filters && { filters: mapping.filters }),
    ...(mapping.inputs_schema && { inputs_schema: mapping.inputs_schema }),
    inputs: wrapInputs(mapping.inputs),
  };
}

export function hogFunctionPayload(spec: HogFunction, hash: string): HogFunctionWrite {
  const secrets = Object.entries(spec.secret_inputs ?? {});
  const missing = secrets.filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `hog function "${spec.key}" secret input(s) ${missing.join(", ")} have no value; set them in the environment`,
    );
  }
  return {
    type: spec.type,
    name: spec.name,
    description: withMarker(spec.description, spec.key, hash),
    enabled: spec.enabled ?? true,
    ...(spec.template_id && { template_id: spec.template_id }),
    hog: spec.hog,
    inputs_schema: spec.inputs_schema,
    inputs: { ...wrapInputs(spec.inputs), ...wrapInputs(Object.fromEntries(secrets)) },
    ...(spec.filters && { filters: spec.filters }),
    ...(spec.mappings && { mappings: spec.mappings.map(mappingPayload) }),
    ...(spec.masking !== undefined && { masking: spec.masking }),
  };
}

export function looksLikeHogFunction(value: unknown): value is HogFunction {
  return getResourceKind(value) === "hog-function";
}

export function validateHogFunctions(specs: HogFunction[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (!spec.key) {
      issues.push("hog-function.key is required");
      continue;
    }
    if (!KEY_PATTERN.test(spec.key)) {
      issues.push(`hog function "${spec.key}" key must match /^[a-zA-Z0-9_-]+$/`);
    }
    if (seen.has(spec.key)) issues.push(`Duplicate hog function key "${spec.key}"`);
    seen.add(spec.key);

    if (!spec.name || spec.name.trim() === "") {
      issues.push(`hog function "${spec.key}" name is required`);
    }
    if (spec.description?.includes(HOG_FUNCTION_IDENTITY_PREFIX)) {
      issues.push(`hog function "${spec.key}" description must not contain the iac marker`);
    }
    if (!spec.hog || spec.hog.trim() === "") {
      issues.push(`hog function "${spec.key}" hog is required`);
    }

    const schemaKeys = new Set(spec.inputs_schema.map((input) => input.key));
    const secretKeys = new Set(
      spec.inputs_schema.filter((input) => input.secret).map((input) => input.key),
    );
    for (const key of Object.keys(spec.inputs ?? {})) {
      if (!schemaKeys.has(key))
        issues.push(`hog function "${spec.key}" input "${key}" is not in inputs_schema`);
      if (secretKeys.has(key)) {
        issues.push(`hog function "${spec.key}" input "${key}" is secret; set it in secret_inputs`);
      }
    }
    for (const key of Object.keys(spec.secret_inputs ?? {})) {
      if (!secretKeys.has(key)) {
        issues.push(
          `hog function "${spec.key}" secret input "${key}" is not a secret in inputs_schema`,
        );
      }
    }

    const mappingNames = new Set<string>();
    for (const mapping of spec.mappings ?? []) {
      if (!mapping.name) issues.push(`hog function "${spec.key}" has a mapping without a name`);
      if (mappingNames.has(mapping.name)) {
        issues.push(`hog function "${spec.key}" has duplicate mapping "${mapping.name}"`);
      }
      mappingNames.add(mapping.name);
    }
  }
  return issues;
}

async function assertManagedHogFunction(
  config: ClientConfig,
  id: string,
  key: string,
  options: { verbose?: boolean },
): Promise<void> {
  const current = await getHogFunction(config, id, options);
  if (hogFunctionKeyFromServer(current) !== key) {
    throw new SafetyViolationError("hog function", id, key);
  }
}

export async function runHogFunctionOp(
  config: ClientConfig,
  op: ResourceOp<HogFunction, ServerHogFunction>,
  _ctx: ApplyContext,
  options: { verbose?: boolean } = {},
): Promise<void> {
  if (op.kind === "unchanged") return;

  const payload = hogFunctionPayload(op.spec, hogFunctionHash(op.spec));

  if (op.kind === "create") {
    await createHogFunction(config, payload, options);
    return;
  }

  await assertManagedHogFunction(config, op.server.id, op.spec.key, options);
  await updateHogFunction(config, op.server.id, payload, options);
}

export async function pruneHogFunction(
  config: ClientConfig,
  orphan: ServerHogFunction,
  options: { verbose?: boolean } = {},
): Promise<boolean> {
  const key = hogFunctionKeyFromServer(orphan) ?? `id:${orphan.id}`;
  try {
    await assertManagedHogFunction(config, orphan.id, key, options);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false;
    throw err;
  }
  await deleteHogFunction(config, orphan.id, options);
  return true;
}

function hogFunctionDisplayFields(values: {
  type: string | null;
  name: string | null;
  description: string | null;
  enabled: boolean;
  inputs: unknown;
  filters: unknown;
  mappings: unknown;
}): DisplayValue {
  return obj([
    ["type", scalar(values.type)],
    ["name", scalar(values.name)],
    ["description", scalar(values.description)],
    ["enabled", scalar(values.enabled)],
    ["inputs", displayJson(values.inputs)],
    ["filters", displayJson(values.filters)],
    ["mappings", displayJson(values.mappings)],
  ]);
}

export function displayHogFunction(spec: HogFunction): DisplayValue {
  const secrets = Object.fromEntries(
    Object.keys(spec.secret_inputs ?? {}).map((key) => [key, SECRET_PLACEHOLDER]),
  );
  return hogFunctionDisplayFields({
    type: spec.type,
    name: spec.name,
    description: spec.description ?? null,
    enabled: spec.enabled ?? true,
    inputs: { ...(spec.inputs ?? {}), ...secrets },
    filters: spec.filters ?? null,
    mappings:
      spec.mappings?.map((mapping) => ({
        name: mapping.name,
        filters: mapping.filters ?? null,
        inputs: mapping.inputs ?? {},
      })) ?? null,
  });
}

/** Server inputs come back as `{ value }`, secrets as `{ secret: true }` without a value. */
function unwrapServerInputs(inputs: unknown): Record<string, unknown> {
  if (!inputs || typeof inputs !== "object") return {};
  return Object.fromEntries(
    Object.entries(inputs as Record<string, { value?: unknown; secret?: boolean }>).map(
      ([key, input]) => [key, input?.secret ? SECRET_PLACEHOLDER : input?.value],
    ),
  );
}

export function displayHogFunctionFromServer(server: ServerHogFunction): DisplayValue {
  const mappings = server.mappings?.map((raw) => {
    const mapping = raw as { name?: string; filters?: unknown; inputs?: unknown };
    return {
      name: mapping.name ?? null,
      filters: mapping.filters ?? null,
      inputs: unwrapServerInputs(mapping.inputs),
    };
  });
  return hogFunctionDisplayFields({
    type: server.type ?? null,
    name: server.name ?? null,
    description: stripMarker(server.description),
    enabled: server.enabled ?? false,
    inputs: unwrapServerInputs(server.inputs),
    filters: server.filters ?? null,
    mappings: mappings ?? null,
  });
}
