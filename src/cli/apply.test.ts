import { describe, expect, it } from "vitest";
import { buildApplyResult } from "./apply.js";
import type { ApplyArgs } from "./args.js";

const config = { host: "https://example.com", projectId: "1", apiKey: "phx_test" };

function args(kinds: string[]): ApplyArgs {
  return {
    command: "apply",
    dir: "does-not-exist",
    dryRun: true,
    verbose: false,
    prune: false,
    json: true,
    kinds,
  };
}

describe("apply --kind", () => {
  it("rejects a kind that isn't a resource", async () => {
    const result = await buildApplyResult(config, args(["flags"]));
    expect(result).toMatchObject({ ok: false, stage: "args" });
    expect(!result.ok && result.error).toContain('--kind "flags" is not a resource kind');
  });

  it("requires the kinds a listed kind depends on", async () => {
    const result = await buildApplyResult(config, args(["feature-flags"]));
    expect(result).toEqual({
      ok: false,
      stage: "args",
      error: "--kind feature-flags also needs cohorts, which feature-flags depends on.",
    });
  });
});
