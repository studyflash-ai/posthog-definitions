import { describe, expect, it } from "vitest";
import { diff } from "../../apply/diff.js";
import type { DesiredState } from "../types.js";
import { externalDataSource } from "../external-data-source/sdk.js";
import { eltDestinationResource } from "./index.js";
import { eltDestination, type EltDestination } from "./sdk.js";
import type { ServerEltDestination } from "./client.js";
import {
  eltDestinationHash,
  eltDestinationKeyFromServer,
  stripMarker,
  validateEltDestinations,
  withMarker,
} from "./pipeline.js";

const sentry = externalDataSource({
  key: "sentry",
  source_type: "Sentry",
  job_inputs: {},
  schemas: [{ name: "issues", sync_type: "full_refresh", sync_frequency: "6hour" }],
});

function spec(overrides: Partial<EltDestination> = {}): EltDestination {
  return eltDestination({
    key: "analytics-db",
    name: "Analytics DB",
    type: "Postgres",
    integration_id: 7,
    config: { database: "analytics", schema: "posthog_sources" },
    tables: [{ source: sentry, schema: "issues" }],
    ...overrides,
  });
}

function serverRow(hash: string, linked: string[]): ServerEltDestination {
  return {
    id: "dst-1",
    type: "Postgres",
    name: withMarker("Analytics DB", "analytics-db", hash),
    config: { database: "analytics", schema: "posthog_sources" },
    integration: 7,
    linked_tables: linked,
  };
}

function state(destinations: EltDestination[]): DesiredState {
  const desired: DesiredState = new Map();
  desired.set("external-data-sources", [{ path: "<test>", spec: sentry }]);
  desired.set(
    "elt-destinations",
    destinations.map((s) => ({ path: "<test>", spec: s })),
  );
  return desired;
}

describe("ELT destination marker", () => {
  it("round-trips key and hash through the name", () => {
    const name = withMarker("Analytics DB", "analytics-db", "abc");
    expect(eltDestinationKeyFromServer(serverRow("abc", []))).toBe("analytics-db");
    expect(stripMarker(name)).toBe("Analytics DB");
  });
});

describe("diff", () => {
  it("is unchanged when the hash matches and every declared table links here", () => {
    const result = diff(
      state([spec()]),
      new Map([["elt-destinations", [serverRow(eltDestinationHash(spec()), ["sentry/issues"])]]]),
      [eltDestinationResource],
    );
    expect(result.get("elt-destinations")!.ops[0]!.kind).toBe("unchanged");
  });

  it("updates when a declared table was detached on the server", () => {
    const result = diff(
      state([spec()]),
      new Map([["elt-destinations", [serverRow(eltDestinationHash(spec()), [])]]]),
      [eltDestinationResource],
    );
    expect(result.get("elt-destinations")!.ops[0]!.kind).toBe("update");
  });
});

describe("validateEltDestinations", () => {
  it("accepts a destination whose tables are declared", () => {
    expect(validateEltDestinations([spec()], state([spec()]))).toEqual([]);
  });

  it("rejects a table the source doesn't sync", () => {
    const bad = spec({ tables: [{ source: sentry, schema: "events" }] });
    expect(validateEltDestinations([bad], state([bad]))).toContain(
      `ELT destination "analytics-db" table sentry/events isn't in that source's schemas`,
    );
  });

  it("rejects a source that isn't declared", () => {
    const other = externalDataSource({ ...sentry, key: "other" });
    const bad = spec({ tables: [{ source: other, schema: "issues" }] });
    expect(validateEltDestinations([bad], state([bad]))).toContain(
      `ELT destination "analytics-db" table other/issues names a source that isn't declared`,
    );
  });

  it("requires an integration", () => {
    const bad = spec({ integration_id: Number.NaN });
    expect(validateEltDestinations([bad], state([bad]))).toContain(
      'ELT destination "analytics-db" integration_id is required',
    );
  });
});
