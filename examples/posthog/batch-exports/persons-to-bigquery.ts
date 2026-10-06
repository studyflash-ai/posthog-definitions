import { batchExport } from "../../../src/index.js";

// Daily persons export to BigQuery, so the sales team can join PostHog person
// properties against the CRM without asking anyone for a CSV.
export default batchExport({
  key: "persons-to-bigquery",
  name: "Persons to BigQuery",
  model: "persons",
  interval: "day",
  destination: {
    type: "BigQuery",
    integration_id: 102,
    config: {
      dataset_id: "posthog",
      table_id: "persons",
      use_json_type: true,
    },
  },
});
