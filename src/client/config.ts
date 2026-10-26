export type ClientConfig = {
  host: string;
  projectId: string;
  apiKey: string;
  /** Sent with every request, e.g. an access proxy's service-token headers in front of a self-hosted instance. */
  headers?: Record<string, string>;
};

export type ConfigOverrides = {
  host?: string;
  projectId?: string;
};

const DEFAULT_HOST = "https://us.posthog.com";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(overrides: ConfigOverrides = {}): ClientConfig {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      "POSTHOG_PERSONAL_API_KEY is not set. Add it to .envrc (and run `direnv allow`) or export it in your shell.",
    );
  }

  const projectId = overrides.projectId ?? process.env.POSTHOG_PROJECT_ID;
  if (!projectId) {
    throw new ConfigError(
      "POSTHOG_PROJECT_ID is not set. Pass --project <id> or set it in .envrc.",
    );
  }

  const host = (overrides.host ?? process.env.POSTHOG_HOST ?? DEFAULT_HOST).replace(/\/$/, "");

  const headers = parseExtraHeaders(process.env.POSTHOG_EXTRA_HEADERS);

  return headers ? { host, projectId, apiKey, headers } : { host, projectId, apiKey };
}

function parseExtraHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("POSTHOG_EXTRA_HEADERS must be a JSON object of header names to values.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((v) => typeof v === "string")
  ) {
    throw new ConfigError("POSTHOG_EXTRA_HEADERS must be a JSON object of header names to values.");
  }
  return parsed as Record<string, string>;
}

/** Headers for every API call: the extra headers, then the API key, which they can't override, whatever the header's case. */
export function requestHeaders(config: ClientConfig): Record<string, string> {
  const extra = Object.entries(config.headers ?? {}).filter(
    ([name]) => name.toLowerCase() !== "authorization",
  );
  return { ...Object.fromEntries(extra), Authorization: `Bearer ${config.apiKey}` };
}
