import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig, requestHeaders } from "./config.js";

describe("loadConfig extra headers", () => {
  afterEach(() => vi.unstubAllEnvs());

  function stubBase(): void {
    vi.stubEnv("POSTHOG_PERSONAL_API_KEY", "phx_test");
    vi.stubEnv("POSTHOG_PROJECT_ID", "1");
  }

  it("leaves headers unset without POSTHOG_EXTRA_HEADERS", () => {
    stubBase();
    vi.stubEnv("POSTHOG_EXTRA_HEADERS", "");
    expect(loadConfig().headers).toBeUndefined();
  });

  it("reads POSTHOG_EXTRA_HEADERS as a JSON object", () => {
    stubBase();
    vi.stubEnv(
      "POSTHOG_EXTRA_HEADERS",
      '{"CF-Access-Client-Id":"id","CF-Access-Client-Secret":"secret"}',
    );
    expect(loadConfig().headers).toEqual({
      "CF-Access-Client-Id": "id",
      "CF-Access-Client-Secret": "secret",
    });
  });

  it.each(["not json", "[]", '{"X-Count": 1}'])("rejects %s", (raw) => {
    stubBase();
    vi.stubEnv("POSTHOG_EXTRA_HEADERS", raw);
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("never lets an extra header replace the API key", () => {
    const headers = requestHeaders({
      host: "https://example.com",
      projectId: "1",
      apiKey: "phx_test",
      headers: { Authorization: "Bearer other", authorization: "Bearer lower", "X-Extra": "1" },
    });
    expect(headers).toEqual({ Authorization: "Bearer phx_test", "X-Extra": "1" });
  });
});
