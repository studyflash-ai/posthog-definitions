import { markResourceKind } from "../types.js";

export type HogFunctionType =
  | "destination"
  | "transformation"
  | "site_destination"
  | "site_app"
  | "internal_destination";

/** One `inputs_schema` entry, exactly as the API takes it. */
export type HogFunctionInputSchema = {
  key: string;
  type: string;
  label?: string;
  required?: boolean;
  secret?: boolean;
  default?: unknown;
  [field: string]: unknown;
};

export type HogFunctionMapping = {
  name: string;
  filters?: Record<string, unknown>;
  /** Plain values; the CLI wraps each one in `{ value }`. */
  inputs?: Record<string, unknown>;
  inputs_schema?: HogFunctionInputSchema[];
};

export type HogFunction = {
  key: string;
  type: HogFunctionType;
  name: string;
  /** The CLI appends its identity marker to it on the server. */
  description?: string;
  enabled?: boolean;
  /** Links the function to a template in the UI. Behaviour comes from `hog` and the schemas. */
  template_id?: string;
  hog: string;
  inputs_schema: HogFunctionInputSchema[];
  /** Plain values; the CLI wraps each one in `{ value }`. */
  inputs?: Record<string, unknown>;
  /**
   * Values for inputs marked `secret` in `inputs_schema`, usually read from the
   * environment. Never hashed or shown in a plan, so a dry run needs none of
   * them; create and update fail when one is missing. A rotated value only
   * reaches the server on the next create or update.
   */
  secret_inputs?: Record<string, string | undefined>;
  filters?: Record<string, unknown>;
  mappings?: HogFunctionMapping[];
  masking?: Record<string, unknown> | null;
};

export function hogFunction(spec: HogFunction): HogFunction {
  return markResourceKind(spec, "hog-function");
}
