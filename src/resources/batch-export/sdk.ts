import { markResourceKind } from "../types.js";

export type BatchExportModel = "events" | "persons" | "sessions";

export type BatchExportInterval = "hour" | "day" | "week" | "every 5 minutes" | "every 15 minutes";

export type BatchExportDestination = {
  /** Destination type as the API names it, e.g. "S3Compatible", "Postgres", "BigQuery". */
  type: string;
  /** Id of the integration holding the destination's credentials, when the type uses one. */
  integration?: number;
  /** Destination config exactly as the API takes it (bucket_name, prefix, include_events, …). */
  config: Record<string, unknown>;
};

/**
 * A batch export, identified by its `name`: batch exports carry no tags or
 * description to hold an `iac:` marker, so the name is the key and must be
 * unique in the project.
 */
export type BatchExport = {
  name: string;
  model: BatchExportModel;
  interval: BatchExportInterval;
  destination: BatchExportDestination;
};

export function batchExport(spec: BatchExport): BatchExport {
  return markResourceKind(spec, "batch-export");
}
