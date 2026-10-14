import { describe, expect, it } from "vitest";
import { diff } from "../../apply/diff.js";
import type { DesiredState } from "../types.js";
import { type HogFunction } from "./sdk.js";
import { type ServerHogFunction } from "./client.js";
import {
  displayHogFunctionFromServer,
  hogFunctionHash,
  hogFunctionHashFromServer,
  hogFunctionKeyFromServer,
  hogFunctionPayload,
  stripMarker,
  validateHogFunctions,
  withMarker,
} from "./pipeline.js";
import { renderLines } from "../../apply/display.js";

function spec(key: string, overrides: Partial<HogFunction> = {}): HogFunction {
  return {
    key,
    type: "destination",
    name: "Ad conversions",
    description: "Sends sign-ups to the ad platform",
    template_id: "template-example",
    hog: "fetch(inputs.url, { 'method': 'POST', 'body': inputs.body })",
    inputs_schema: [
      { key: "url", type: "string", required: true },
      { key: "token", type: "string", required: true, secret: true },
    ],
    inputs: { url: "https://ads.example.com/track" },
    secret_inputs: { token: "s3cr3t" },
    mappings: [
      {
        name: "Sign-up",
        filters: { events: [{ id: "signed_up", type: "events" }] },
        inputs_schema: [{ key: "eventName", type: "string" }],
        inputs: { eventName: "Registration" },
      },
    ],
    ...overrides,
  };
}

function serverRow(
  id: string,
  key: string,
  hash: string,
  overrides: Partial<ServerHogFunction> = {},
): ServerHogFunction {
  return {
    id,
    type: "destination",
    name: "Ad conversions",
    description: withMarker("Sends sign-ups to the ad platform", key, hash),
    enabled: true,
    ...overrides,
  };
}

function desiredFor(specs: HogFunction[]): DesiredState {
  const state: DesiredState = new Map();
  state.set(
    "hog-functions",
    specs.map((spec) => ({ path: "<test>", spec })),
  );
  return state;
}

function currentFor(rows: ServerHogFunction[]): Map<string, unknown[]> {
  return new Map<string, unknown[]>([["hog-functions", rows]]);
}

describe("hog function pipeline", () => {
  it("emits create when desired has no matching server row", () => {
    const slice = diff(desiredFor([spec("ads")]), currentFor([])).get("hog-functions")!;
    expect(slice.ops.map((op) => op.kind)).toEqual(["create"]);
  });

  it("emits unchanged when the server hash matches", () => {
    const desired = spec("ads");
    const server = serverRow("uuid-1", "ads", hogFunctionHash(desired));
    const op = diff(desiredFor([desired]), currentFor([server])).get("hog-functions")!.ops[0]!;
    expect(op.kind).toBe("unchanged");
  });

  it("emits update when the server hash differs", () => {
    const server = serverRow("uuid-1", "ads", "0000000000000000");
    const op = diff(desiredFor([spec("ads")]), currentFor([server])).get("hog-functions")!.ops[0]!;
    expect(op.kind).toBe("update");
  });

  it("classifies a managed server-only row as an orphan", () => {
    const server = serverRow("uuid-ghost", "ghost", "abc123");
    const slice = diff(desiredFor([]), currentFor([server])).get("hog-functions")!;
    expect(slice.orphans).toEqual([server]);
  });

  it("safety invariant: ignores rows without the marker", () => {
    const handBuilt = serverRow("uuid-hand", "x", "y", { description: "Built in the UI" });
    const slice = diff(desiredFor([spec("ads")]), currentFor([handBuilt])).get("hog-functions")!;
    expect(slice.ops.map((op) => op.kind)).toEqual(["create"]);
    expect(slice.orphans).toEqual([]);
  });

  it("reads key and hash from the description marker and strips it", () => {
    const server = serverRow("u", "ads", "deadbeef");
    expect(hogFunctionKeyFromServer(server)).toBe("ads");
    expect(hogFunctionHashFromServer(server)).toBe("deadbeef");
    expect(stripMarker(server.description)).toBe("Sends sign-ups to the ad platform");
  });

  it("hash ignores secret values but not which inputs are secret", () => {
    const base = spec("ads");
    expect(hogFunctionHash(spec("ads", { secret_inputs: { token: "rotated" } }))).toBe(
      hogFunctionHash(base),
    );
    expect(hogFunctionHash(spec("ads", { secret_inputs: { token: undefined } }))).toBe(
      hogFunctionHash(base),
    );
    expect(hogFunctionHash(spec("ads", { secret_inputs: {} }))).not.toBe(hogFunctionHash(base));
    expect(hogFunctionHash(spec("ads", { enabled: false }))).not.toBe(hogFunctionHash(base));
  });

  it("payload wraps inputs, merges secrets and marks the description", () => {
    const payload = hogFunctionPayload(spec("ads"), "abc123");
    expect(payload.description).toBe(
      "Sends sign-ups to the ad platform\n\n<!-- iac:hog-functions:ads iac:hash:abc123 -->",
    );
    expect(payload.enabled).toBe(true);
    expect(payload.inputs).toEqual({
      url: { value: "https://ads.example.com/track" },
      token: { value: "s3cr3t" },
    });
    expect(payload.mappings).toEqual([
      {
        name: "Sign-up",
        filters: { events: [{ id: "signed_up", type: "events" }] },
        inputs_schema: [{ key: "eventName", type: "string" }],
        inputs: { eventName: { value: "Registration" } },
      },
    ]);
  });

  it("payload refuses to send a secret input without a value", () => {
    expect(() =>
      hogFunctionPayload(spec("ads", { secret_inputs: { token: undefined } }), "abc"),
    ).toThrow(/token have no value/);
  });

  it("validates keys, inputs against the schema and secret placement", () => {
    const issues = validateHogFunctions([
      spec("ads"),
      spec("ads"),
      spec("bad key"),
      spec("unknown-input", { inputs: { nope: 1 } }),
      spec("secret-in-inputs", { inputs: { token: "plain" }, secret_inputs: {} }),
      spec("not-secret", { secret_inputs: { url: "x" } }),
      spec("marked", { description: "x <!-- iac:hog-functions:y iac:hash:z -->" }),
    ]);
    expect(issues).toEqual([
      'Duplicate hog function key "ads"',
      'hog function "bad key" key must match /^[a-zA-Z0-9_-]+$/',
      'hog function "unknown-input" input "nope" is not in inputs_schema',
      'hog function "secret-in-inputs" input "token" is secret; set it in secret_inputs',
      'hog function "not-secret" secret input "url" is not a secret in inputs_schema',
      'hog function "marked" description must not contain the iac marker',
    ]);
  });

  it("never displays secret values from the server", () => {
    const server = serverRow("u", "ads", "h", {
      inputs: { url: { value: "https://ads.example.com/track" }, token: { secret: true } },
    });
    const lines = renderLines(displayHogFunctionFromServer(server)).join("\n");
    expect(lines).toContain("<secret>");
    expect(lines).toContain("https://ads.example.com/track");
  });
});
