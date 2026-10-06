import { markResourceKind } from "../types.js";

export type BatchExportModel = "events" | "persons" | "sessions";

export type BatchExportInterval = "hour" | "day" | "week" | "every 5 minutes" | "every 15 minutes";

export type BatchExportDestinationType =
  | "AwsS3"
  | "S3Compatible"
  | "Snowflake"
  | "Postgres"
  | "Redshift"
  | "BigQuery"
  | "Databricks"
  | "AzureBlob";

export type BatchExportDestination = {
  type: BatchExportDestinationType;
  /**
   * Id of the team-scoped Integration holding the destination's credentials.
   * Credentials never live in `config`; create the integration in the PostHog
   * UI and reference it here.
   */
  integration_id: number;
  /**
   * Destination-specific settings, exactly as the API takes them (e.g.
   * `bucket_name`, `prefix`, `file_format` for S3; `database`, `schema`,
   * `table_name` for Postgres). Event filters such as `include_events` live
   * here too.
   */
  config: Record<string, unknown>;
};

export type BatchExport = {
  key: string;
  /** Display name. The CLI appends its identity marker to it on the server. */
  name: string;
  model: BatchExportModel;
  interval: BatchExportInterval;
  destination: BatchExportDestination;
  paused?: boolean;
};

export function batchExport(spec: BatchExport): BatchExport {
  return markResourceKind(spec, "batch-export");
}
