import type { ExternalDataSource } from "../external-data-source/sdk.js";
import { markResourceKind } from "../types.js";

export type EltDestinationType =
  | "Postgres"
  | "Redshift"
  | "Snowflake"
  | "BigQuery"
  | "Databricks"
  | "S3"
  | "AzureBlob";

/** One table of a declared source, by the name in that source's `schemas`. */
export type EltDestinationTable = {
  source: ExternalDataSource;
  schema: string;
};

export type EltDestination = {
  key: string;
  /** Display name. The CLI appends its identity marker to it on the server. */
  name: string;
  type: EltDestinationType;
  /**
   * Id of the team-scoped Integration holding the destination's credentials
   * (a `postgresql` integration for Postgres). Credentials never live in
   * `config`. Fixed once the destination exists.
   */
  integration_id: number;
  /**
   * Where rows land, exactly as the API takes it: `database` and `schema` for
   * Postgres. Those two are fixed once the destination exists.
   */
  config: Record<string, unknown>;
  /**
   * Tables that also sync here. Each keeps the destinations it already has,
   * the PostHog warehouse included; apply only adds and removes this one.
   */
  tables: EltDestinationTable[];
};

export function eltDestination(spec: EltDestination): EltDestination {
  return markResourceKind(spec, "elt-destination");
}
