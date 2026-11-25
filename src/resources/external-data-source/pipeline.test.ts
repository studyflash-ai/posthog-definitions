import { describe, expect, it } from "vitest";
import { diff } from "../../apply/diff.js";
import { renderLines } from "../../apply/display.js";
import type { DesiredState } from "../types.js";
import { externalDataSourceResource } from "./index.js";
import { externalDataSource, type ExternalDataSource } from "./sdk.js";
import type { ServerExternalDataSource } from "./client.js";
import {
  displayExternalDataSource,
  externalDataSourceHash,
  externalDataSourceKeyFromServer,
  schemaChanges,
  stripMarker,
  validateExternalDataSources,
  withMarker,
} from "./pipeline.js";

function spec(overrides: Partial<ExternalDataSource> = {}): ExternalDataSource {
  return externalDataSource({
    key: "sentry",
    source_type: "Sentry",
    job_inputs: { organization_slug: "acme" },
    secrets: { auth_token: "sntrys_secret_value" },
    schemas: [{ name: "issues", sync_type: "full_refresh", sync_frequency: "6hour" }],
    ...overrides,
  });
}

function serverRow(overrides: Partial<ServerExternalDataSource> = {}): ServerExternalDataSource {
  return {
    id: "src-1",
    source_type: "Sentry",
    prefix: "",
    description: null,
    job_inputs: { organization_slug: "acme" },
    schemas: [
      {
        id: "sch-1",
        name: "issues",
        should_sync: true,
        sync_type: "full_refresh",
        sync_frequency: "6hour",
      },
    ],
    ...overrides,
  };
}

function desiredFor(specs: ExternalDataSource[]): DesiredState {
  return new Map([["external-data-sources", specs.map((s) => ({ path: "<test>", spec: s }))]]);
}

describe("external data source marker", () => {
  it("round-trips key and hash through the description", () => {
    const description = withMarker("Our Sentry", "sentry", "abc123");
    expect(description).toBe("Our Sentry [iac:external-data-sources:sentry iac:hash:abc123]");
    expect(externalDataSourceKeyFromServer(serverRow({ description }))).toBe("sentry");
    expect(stripMarker(description)).toBe("Our Sentry");
  });

  it("is the whole description when there is no user text", () => {
    expect(withMarker("", "sentry", "abc")).toBe("[iac:external-data-sources:sentry iac:hash:abc]");
  });
});

describe("diff", () => {
  it("adopts the unmanaged source with the same type and prefix instead of creating one", () => {
    const result = diff(desiredFor([spec()]), new Map([["external-data-sources", [serverRow()]]]), [
      externalDataSourceResource,
    ]);
    const ops = result.get("external-data-sources")!.ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("update");
    expect(result.get("external-data-sources")!.orphans).toEqual([]);
  });

  it("creates when only a source with another prefix exists", () => {
    const result = diff(
      desiredFor([spec()]),
      new Map([["external-data-sources", [serverRow({ prefix: "other_" })]]]),
      [externalDataSourceResource],
    );
    expect(result.get("external-data-sources")!.ops[0]!.kind).toBe("create");
  });

  it("is unchanged once the marker carries the spec's hash", () => {
    const description = withMarker("", "sentry", externalDataSourceHash(spec()));
    const result = diff(
      desiredFor([spec()]),
      new Map([["external-data-sources", [serverRow({ description })]]]),
      [externalDataSourceResource],
    );
    expect(result.get("external-data-sources")!.ops[0]!.kind).toBe("unchanged");
  });

  it("never adopts a source another key manages", () => {
    const description = withMarker("", "other", "abc");
    const result = diff(
      desiredFor([spec()]),
      new Map([["external-data-sources", [serverRow({ description })]]]),
      [externalDataSourceResource],
    );
    expect(result.get("external-data-sources")!.ops[0]!.kind).toBe("create");
  });
});

describe("externalDataSourceHash", () => {
  it("changes when a secret rotates", () => {
    expect(externalDataSourceHash(spec())).not.toBe(
      externalDataSourceHash(spec({ secrets: { auth_token: "rotated" } })),
    );
  });
});

describe("displayExternalDataSource", () => {
  it("names secrets without their values", () => {
    const lines = renderLines(displayExternalDataSource(spec())).join("\n");
    expect(lines).toContain("auth_token: (secret)");
    expect(lines).not.toContain("sntrys_secret_value");
  });
});

describe("schemaChanges", () => {
  it("is empty when the table is as declared", () => {
    expect(schemaChanges(spec().schemas[0]!, serverRow().schemas![0]!)).toEqual({});
  });

  it("sends the sync type with its incremental field", () => {
    const changes = schemaChanges(
      {
        name: "issues",
        sync_type: "incremental",
        sync_frequency: "6hour",
        incremental_field: "updated_at",
        incremental_field_type: "datetime",
      },
      { ...serverRow().schemas![0]!, incremental_field: "updated_at" },
    );
    expect(changes).toEqual({
      sync_type: "incremental",
      incremental_field: "updated_at",
      incremental_field_type: "datetime",
    });
  });

  it("turns a table back on", () => {
    expect(
      schemaChanges(spec().schemas[0]!, { ...serverRow().schemas![0]!, should_sync: false }),
    ).toEqual({ should_sync: true });
  });
});

describe("validateExternalDataSources", () => {
  it("accepts a valid spec", () => {
    expect(validateExternalDataSources([spec()])).toEqual([]);
  });

  it("rejects two sources with the same type and prefix", () => {
    expect(validateExternalDataSources([spec(), spec({ key: "sentry-2" })])).toContain(
      'external data source "sentry-2" has the same source_type and prefix as another source',
    );
  });

  it("requires an incremental field for incremental tables", () => {
    expect(
      validateExternalDataSources([
        spec({ schemas: [{ name: "issues", sync_type: "incremental", sync_frequency: "6hour" }] }),
      ]),
    ).toContain(
      'external data source "sentry" schema "issues" needs an incremental_field for incremental',
    );
  });

  it("rejects a setting declared as both job input and secret", () => {
    expect(validateExternalDataSources([spec({ job_inputs: { auth_token: "x" } })])).toContain(
      'external data source "sentry" sets auth_token in both job_inputs and secrets',
    );
  });
});
