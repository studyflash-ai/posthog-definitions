import { eltDestination } from "../../../src/index.js";
import stripe from "../external-data-sources/stripe.js";

// Invoices also land in our own Postgres; they keep syncing to the PostHog warehouse too.
export default eltDestination({
  key: "warehouse-postgres",
  name: "Warehouse Postgres",
  type: "Postgres",
  integration_id: 104,
  config: { database: "warehouse", schema: "posthog_sources" },
  tables: [{ source: stripe, schema: "Invoice" }],
});
