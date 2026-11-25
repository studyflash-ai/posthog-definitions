import { markResourceKind } from "../types.js";

export type ExternalDataSchemaSyncType = "full_refresh" | "incremental" | "append";

export type ExternalDataSchemaSyncFrequency =
  | "never"
  | "5min"
  | "15min"
  | "30min"
  | "1hour"
  | "6hour"
  | "12hour"
  | "24hour"
  | "7day"
  | "30day";

/** One table of a source, by the name the source's schema discovery gives it. */
export type ExternalDataSchema = {
  name: string;
  sync_type: ExternalDataSchemaSyncType;
  sync_frequency: ExternalDataSchemaSyncFrequency;
  /** The column an incremental or append sync resumes from. */
  incremental_field?: string;
  incremental_field_type?: "datetime" | "date" | "timestamp" | "integer" | "numeric" | "objectid";
};

export type ExternalDataSource = {
  key: string;
  /** The connector, as the API names it: `Sentry`, `Github`, `Stripe`, `Postgres`, … */
  source_type: string;
  /**
   * Prefix of the tables PostHog creates. Fixed once the source exists. With
   * `source_type` it names the source within the project, which is how apply
   * adopts a source created before it was declared.
   */
  prefix?: string;
  /** Free text. The CLI appends its identity marker to it on the server. */
  description?: string;
  /** The connector's non-secret settings (the API's `job_inputs`). */
  job_inputs: Record<string, unknown>;
  /**
   * Secret settings, merged into `job_inputs` when sent. Read them from the
   * environment; plan output never shows their values, and the server never
   * returns them.
   */
  secrets?: Record<string, string>;
  /**
   * The tables to sync. Tables the source has that aren't listed are left as
   * they are on the server.
   */
  schemas: ExternalDataSchema[];
};

export function externalDataSource(spec: ExternalDataSource): ExternalDataSource {
  return markResourceKind(spec, "external-data-source");
}
