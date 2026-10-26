import type { ApplyContext, CollectionResourceModule } from "../types.js";
import { cohortResource } from "../cohort/index.js";
import type { FeatureFlag } from "./sdk.js";
import {
  displayFeatureFlag,
  displayFeatureFlagFromServer,
  FEATURE_FLAG_TAG_PREFIX,
  featureFlagHash,
  featureFlagHashFromTags,
  featureFlagKeyFromTags,
  looksLikeFeatureFlag,
  pruneFeatureFlag,
  runFeatureFlagOp,
  validateFeatureFlags,
} from "./pipeline.js";
import {
  getFeatureFlag,
  listFeatureFlags,
  listManagedFeatureFlags,
  type ServerFeatureFlag,
} from "./client.js";
import {
  pullDependencies,
  pullFilter,
  pullLabel,
  renderToFile,
  serverIdOf,
  tagOnServer,
} from "./codegen.js";

export { featureFlag } from "./sdk.js";
export type {
  FeatureFlag,
  FeatureFlagFilters,
  ReleaseConditionGroup,
  Variant,
  PropertyFilter,
} from "./sdk.js";

export const featureFlagResource: CollectionResourceModule<FeatureFlag, ServerFeatureFlag> = {
  kind: "collection",
  name: "feature-flags",
  displayName: "feature flag",
  identityPrefix: FEATURE_FLAG_TAG_PREFIX,
  dependsOn: [cohortResource],

  isSpec: looksLikeFeatureFlag,
  specKey: (spec) => spec.key,

  list: listManagedFeatureFlags,
  keyFromServer: (server) => featureFlagKeyFromTags(server.tags),
  hashFromServer: (server) => featureFlagHashFromTags(server.tags),

  hash: featureFlagHash,
  validate: (specs, state) => validateFeatureFlags(specs, state),
  executeOp: runFeatureFlagOp,
  prune: pruneFeatureFlag,

  displaySpec: (spec, _ctx: ApplyContext) => displayFeatureFlag(spec),
  displayServer: (server, ctx: ApplyContext) => displayFeatureFlagFromServer(server, ctx),

  listAll: listFeatureFlags,
  getById: (config, id, options) =>
    getFeatureFlag(config, typeof id === "string" ? Number(id) : id, options),
  pullFilter,
  pullLabel,
  serverIdOf,
  pullDependencies,
  renderToFile,
  tagOnServer,
};
