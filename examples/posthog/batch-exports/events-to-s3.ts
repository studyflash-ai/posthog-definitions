import { batchExport } from "../../../src/index.js";

// Hourly event export to S3 as gzipped JSONLines, filtered to the events the
// finance team actually queries. The bucket key lives in the integration
// (created once in the PostHog UI), never in `config`.
export default batchExport({
  key: "events-to-s3",
  name: "Billing events to S3",
  model: "events",
  interval: "hour",
  destination: {
    type: "AwsS3",
    integration_id: 101,
    config: {
      bucket_name: "analytics-exports",
      region: "eu-central-1",
      prefix: "posthog/events/{year}-{month}-{day}/",
      file_format: "JSONLines",
      compression: "gzip",
      include_events: ["subscription_started", "subscription_renewed", "subscription_canceled"],
    },
  },
});
