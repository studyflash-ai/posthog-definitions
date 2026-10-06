import { describe, expect, it } from "vitest";
import { ServerBatchExportSchema } from "./client.js";

// Shape of a real GET /api/projects/{id}/batch_exports/{id}/ response for an
// S3-compatible export (identifiers and bucket replaced; latest_runs trimmed).
const fixture = {
  id: "01a08ae8-1a62-0001-c32c-a0854ef19190",
  team_id: 1,
  name: "Persons to the data lake",
  model: "persons",
  destination: {
    type: "S3Compatible",
    config: {
      prefix: "persons/{year}-{month}-{day}/{hour}/",
      region: "auto",
      bucket_name: "lake",
      compression: "gzip",
      file_format: "JSONLines",
      use_virtual_style_addressing: false,
    },
    integration: 101,
  },
  interval: "hour",
  paused: false,
  created_at: "2026-09-10T10:41:02.195339Z",
  last_updated_at: "2026-09-10T11:54:16.798874Z",
  last_paused_at: "2026-09-10T11:53:37.125333Z",
  start_at: null,
  end_at: null,
  latest_runs: [],
  hogql_query: null,
  hogql_modifiers: null,
  schema: null,
  filters: null,
  timezone: "UTC",
  offset_day: null,
  offset_hour: null,
};

describe("ServerBatchExportSchema", () => {
  it("parses a real-shaped response", () => {
    const parsed = ServerBatchExportSchema.parse(fixture);
    expect(parsed.destination.integration).toBe(101);
    expect(parsed.destination.config.bucket_name).toBe("lake");
  });

  it("rejects a response without a destination", () => {
    const { destination: _destination, ...broken } = fixture;
    expect(() => ServerBatchExportSchema.parse(broken)).toThrow();
  });
});
