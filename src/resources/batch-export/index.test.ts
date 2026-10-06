import { describe, expect, it } from "vitest";
import { diff } from "../../apply/diff.js";
import { batchExport, batchExportResource } from "./index.js";
import type { ServerBatchExport } from "./client.js";

const spec = batchExport({
  name: "Events to R2",
  model: "events",
  interval: "hour",
  destination: {
    type: "S3Compatible",
    integration: 1,
    config: { bucket_name: "b", prefix: "events/", include_events: ["$pageview"] },
  },
});

function server(
  overrides: Partial<ServerBatchExport["destination"]["config"]> = {},
): ServerBatchExport {
  return {
    id: "01a",
    name: "Events to R2",
    model: "events",
    interval: "hour",
    paused: false,
    destination: {
      type: "S3Compatible",
      integration: 1,
      // Server-side nulls are not declared state.
      config: {
        bucket_name: "b",
        prefix: "events/",
        include_events: ["$pageview"],
        max_file_size_mb: null,
        ...overrides,
      },
    },
  };
}

function plan(rows: ServerBatchExport[]) {
  const result = diff(
    new Map([["batch-exports", [{ path: "x.ts", spec }]]]),
    new Map([["batch-exports", rows]]),
    [batchExportResource],
  );
  return result.get("batch-exports")!;
}

describe("batch exports", () => {
  it("is unchanged when the live export matches", () => {
    expect(plan([server()]).ops.map((o) => o.kind)).toEqual(["unchanged"]);
  });

  it("updates when the live config drifts", () => {
    expect(plan([server({ include_events: ["$identify"] })]).ops.map((o) => o.kind)).toEqual([
      "update",
    ]);
  });

  it("creates when no export has the name", () => {
    expect(plan([]).ops.map((o) => o.kind)).toEqual(["create"]);
  });

  it("lists undeclared exports as orphans but never prunes them", async () => {
    const other = { ...server(), id: "01b", name: "Sessions" };
    expect(plan([server(), other]).orphans).toEqual([other]);
    expect(await batchExportResource.prune({ host: "", projectId: "", apiKey: "" }, other)).toBe(
      false,
    );
  });

  it("rejects duplicate names", () => {
    expect(batchExportResource.validate([spec, spec], new Map())).toEqual([
      'Duplicate batch export name "Events to R2"',
    ]);
  });
});
