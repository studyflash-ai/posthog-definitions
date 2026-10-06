import { describe, expect, it } from "vitest";
import type { PullRenderContext } from "../../pull/types.js";
import { pullFilter, pullLabel, renderToFile } from "./codegen.js";
import type { ServerBatchExport } from "./client.js";

function makeCtx(): PullRenderContext & { warnings: string[] } {
  const taken = new Set<string>();
  const warnings: string[] = [];
  return {
    warnings,
    uniqueSlug: (base) => {
      let s = base;
      let i = 2;
      while (taken.has(s)) s = `${base}-${i++}`;
      taken.add(s);
      return s;
    },
    importForServerId: () => {
      throw new Error("batch export codegen should not call importForServerId");
    },
    importForServerIdOptional: () => undefined,
    warn: (m) => warnings.push(m),
  };
}

function batchExport(overrides: Partial<ServerBatchExport> = {}): ServerBatchExport {
  return {
    id: "0192f1c2-0000-0000-0000-000000000001",
    name: "Signups to the warehouse",
    model: "events",
    interval: "hour",
    paused: false,
    timezone: "UTC",
    destination: {
      type: "Postgres",
      integration: 42,
      config: {
        database: "analytics",
        schema: "posthog",
        table_name: "events",
        has_self_signed_cert: false,
        include_events: ["user_signed_up"],
        exclude_events: null,
      },
    },
    ...overrides,
  };
}

describe("batch export codegen", () => {
  it("pullFilter drops HogQL-model exports and exports without an integration", () => {
    expect(pullFilter(batchExport()).kept).toBe(true);
    expect(pullFilter(batchExport({ model: "hogql" })).kept).toBe(false);
    const legacy = batchExport();
    legacy.destination = { ...legacy.destination, integration: null };
    expect(pullFilter(legacy).kept).toBe(false);
  });

  it("pullLabel strips the marker and shows model, destination and paused", () => {
    const label = pullLabel(
      batchExport({ name: "Signups [iac:batch-exports:signups iac:hash:abc123]", paused: true }),
    );
    expect(label).toEqual({ primary: "Signups", secondary: "events → Postgres [paused]" });
  });

  it("renders a batchExport() file without null config values", () => {
    const ctx = makeCtx();
    const rendered = renderToFile(batchExport(), ctx);
    if ("skipped" in rendered) throw new Error("unexpected skip");
    expect(rendered.filename).toBe("signups-to-the-warehouse.ts");
    expect(rendered.specKey).toBe("signups-to-the-warehouse");
    expect(rendered.contents).toContain('import { batchExport } from "@posthog/definitions";');
    expect(rendered.contents).toContain('key: "signups-to-the-warehouse"');
    expect(rendered.contents).toContain("integration_id: 42");
    expect(rendered.contents).toContain('"user_signed_up"');
    expect(rendered.contents).not.toContain("exclude_events");
    expect(rendered.contents).toContain(
      '  destination: {\n    type: "Postgres",\n    integration_id: 42,\n    config: {\n      database: "analytics",',
    );
    expect(rendered.contents).not.toContain("paused");
    expect(ctx.warnings).toEqual([]);
  });

  it("warns about settings apply doesn't manage", () => {
    const ctx = makeCtx();
    renderToFile(batchExport({ interval: "day", offset_hour: 3, timezone: "Europe/Zurich" }), ctx);
    expect(ctx.warnings).toEqual([
      'Batch export "signups-to-the-warehouse" sets offset_hour, which apply doesn\'t manage yet.',
      'Batch export "signups-to-the-warehouse" uses timezone Europe/Zurich, which apply doesn\'t manage yet.',
    ]);
  });
});
