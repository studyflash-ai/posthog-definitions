import { describe, expect, it } from "vitest";
import { diff } from "../../apply/diff.js";
import type { DesiredState } from "../types.js";
import { type BatchExport } from "./sdk.js";
import { type ServerBatchExport } from "./client.js";
import {
  batchExportHash,
  batchExportHashFromServer,
  batchExportKeyFromServer,
  batchExportPayload,
  stripMarker,
  validateBatchExports,
  withMarker,
} from "./pipeline.js";

function spec(key: string, overrides: Partial<BatchExport> = {}): BatchExport {
  return {
    key,
    name: "Events to the data lake",
    model: "events",
    interval: "hour",
    destination: {
      type: "S3Compatible",
      integration_id: 101,
      config: { bucket_name: "lake", region: "auto", prefix: "events/", file_format: "JSONLines" },
    },
    ...overrides,
  };
}

function serverRow(
  id: string,
  key: string,
  hash: string,
  overrides: Partial<ServerBatchExport> = {},
): ServerBatchExport {
  return {
    id,
    name: withMarker("Events to the data lake", key, hash),
    model: "events",
    interval: "hour",
    paused: false,
    destination: {
      type: "S3Compatible",
      integration: 101,
      config: { bucket_name: "lake", region: "auto", prefix: "events/", file_format: "JSONLines" },
    },
    ...overrides,
  };
}

function desiredFor(specs: BatchExport[]): DesiredState {
  const state: DesiredState = new Map();
  state.set(
    "batch-exports",
    specs.map((spec) => ({ path: "<test>", spec })),
  );
  return state;
}

function currentFor(rows: ServerBatchExport[]): Map<string, unknown[]> {
  return new Map<string, unknown[]>([["batch-exports", rows]]);
}

describe("batch export pipeline", () => {
  it("emits create when desired has no matching server row", () => {
    const slice = diff(desiredFor([spec("lake")]), currentFor([])).get("batch-exports")!;
    expect(slice.ops.map((op) => op.kind)).toEqual(["create"]);
  });

  it("emits unchanged when server hash matches the desired spec's hash", () => {
    const desired = spec("lake");
    const server = serverRow("uuid-1", "lake", batchExportHash(desired));
    const op = diff(desiredFor([desired]), currentFor([server])).get("batch-exports")!.ops[0]!;
    expect(op.kind).toBe("unchanged");
  });

  it("emits update when server hash differs", () => {
    const server = serverRow("uuid-1", "lake", "0000000000000000");
    const op = diff(desiredFor([spec("lake")]), currentFor([server])).get("batch-exports")!.ops[0]!;
    expect(op.kind).toBe("update");
    if (op.kind === "update") expect((op.server as ServerBatchExport).id).toBe("uuid-1");
  });

  it("classifies a server-only managed batch export as an orphan", () => {
    const server = serverRow("uuid-ghost", "ghost", "abc123");
    const slice = diff(desiredFor([]), currentFor([server])).get("batch-exports")!;
    expect(slice.orphans).toEqual([server]);
  });

  it("safety invariant: ignores server rows without the iac:* marker", () => {
    const handBuilt = serverRow("uuid-hand", "x", "y", { name: "Events to the data lake" });
    const slice = diff(desiredFor([spec("lake")]), currentFor([handBuilt])).get("batch-exports")!;
    expect(slice.ops.map((op) => op.kind)).toEqual(["create"]);
    expect(slice.orphans).toEqual([]);
  });

  it("safety invariant: ignores rows whose marker is not at the end of the name", () => {
    const tampered = serverRow("uuid-tampered", "x", "y", {
      name: "Lake [iac:batch-exports:lake iac:hash:abc123] (copy)",
    });
    const slice = diff(desiredFor([]), currentFor([tampered])).get("batch-exports")!;
    expect(slice.ops).toEqual([]);
    expect(slice.orphans).toEqual([]);
  });

  it("extracts key and hash from the marker and strips it for display", () => {
    const server = serverRow("u", "lake", "deadbeef");
    expect(batchExportKeyFromServer(server)).toBe("lake");
    expect(batchExportHashFromServer(server)).toBe("deadbeef");
    expect(stripMarker(server.name)).toBe("Events to the data lake");
  });

  it("hash ignores null config values and treats paused as false by default", () => {
    const base = spec("lake");
    const withNull = spec("lake", {
      paused: false,
      destination: {
        ...base.destination,
        config: { ...base.destination.config, max_file_size_mb: null },
      },
    });
    expect(batchExportHash(withNull)).toBe(batchExportHash(base));
    expect(batchExportHash(spec("lake", { paused: true }))).not.toBe(batchExportHash(base));
  });

  it("payload carries the marker in the name and the destination type", () => {
    const payload = batchExportPayload(spec("lake"), "abc123");
    expect(payload.name).toBe("Events to the data lake [iac:batch-exports:lake iac:hash:abc123]");
    expect(payload.destination.type).toBe("S3Compatible");
    expect(payload.destination.integration_id).toBe(101);
  });

  it("validates key, name and destination", () => {
    const issues = validateBatchExports([
      spec("lake"),
      spec("lake"),
      spec("bad key"),
      spec("marked", { name: "Lake [iac:batch-exports:x iac:hash:y]" }),
      spec("no-integration", {
        destination: { type: "Postgres", config: {} } as unknown as BatchExport["destination"],
      }),
    ]);
    expect(issues).toEqual([
      'Duplicate batch export key "lake"',
      'batch export "bad key" key must match /^[a-zA-Z0-9_-]+$/',
      'batch export "marked" name must not contain the iac marker',
      'batch export "no-integration" destination.integration_id is required',
    ]);
  });
});
