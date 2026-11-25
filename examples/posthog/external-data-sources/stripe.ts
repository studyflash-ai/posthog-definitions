import { externalDataSource } from "../../../src/index.js";

// The key is read from the environment, so it never lands in the repo or in a plan.
export default externalDataSource({
  key: "stripe",
  source_type: "Stripe",
  description: "Billing data for revenue dashboards",
  job_inputs: {},
  secrets: { stripe_secret_key: process.env.STRIPE_RESTRICTED_KEY ?? "" },
  schemas: [
    { name: "Customer", sync_type: "full_refresh", sync_frequency: "24hour" },
    {
      name: "Invoice",
      sync_type: "incremental",
      sync_frequency: "6hour",
      incremental_field: "created",
      incremental_field_type: "integer",
    },
  ],
});
