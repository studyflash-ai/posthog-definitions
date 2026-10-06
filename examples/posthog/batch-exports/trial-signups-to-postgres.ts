import { batchExport } from "../../../src/index.js";

// Paused until the warehouse migration lands. Declaring it paused keeps the
// config reviewed in code without anything running on the schedule.
export default batchExport({
  key: "trial-signups-to-postgres",
  name: "Trial signups to the warehouse",
  model: "events",
  interval: "every 15 minutes",
  paused: true,
  destination: {
    type: "Postgres",
    integration_id: 103,
    config: {
      database: "warehouse",
      schema: "posthog",
      table_name: "trial_signups",
      has_self_signed_cert: false,
      include_events: ["trial_started"],
    },
  },
});
