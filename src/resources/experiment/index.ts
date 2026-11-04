import type { ApplyContext, CollectionResourceModule } from "../types.js";
import type { ServerCohort } from "../cohort/client.js";
import { cohortResource } from "../cohort/index.js";
import { experimentHoldoutResource } from "../experiment-holdout/index.js";
import { experimentSavedMetricResource } from "../experiment-saved-metric/index.js";
import { featureFlagResource } from "../feature-flag/index.js";
import type { Experiment } from "./sdk.js";
import {
  displayExperiment,
  displayExperimentFromServer,
  EXPERIMENT_IDENTITY_PREFIX,
  experimentCohortRefsStale,
  experimentHash,
  experimentHashFromServer,
  experimentKeyFromServer,
  looksLikeExperiment,
  pruneExperiment,
  runExperimentOp,
  validateExperiments,
} from "./pipeline.js";
import {
  getExperiment,
  listExperiments,
  listManagedExperiments,
  type ServerExperiment,
} from "./client.js";
import {
  pullDependencies,
  pullFilter,
  pullLabel,
  renderToFile,
  serverIdOf,
  tagOnServer,
} from "./codegen.js";

export { experiment } from "./sdk.js";
export type {
  Experiment,
  ExperimentLifecycle,
  ExperimentType,
  ExperimentConclusion,
  ExperimentVariant,
  ExperimentParameters,
  ExperimentMetric,
  ExperimentExposureCriteria,
} from "./sdk.js";

export const experimentResource: CollectionResourceModule<Experiment, ServerExperiment> = {
  kind: "collection",
  name: "experiments",
  displayName: "experiment",
  identityPrefix: EXPERIMENT_IDENTITY_PREFIX,
  dependsOn: [
    cohortResource,
    featureFlagResource,
    experimentHoldoutResource,
    experimentSavedMetricResource,
  ],

  isSpec: looksLikeExperiment,
  specKey: (spec) => spec.key,

  list: listManagedExperiments,
  keyFromServer: (server) => experimentKeyFromServer(server),
  hashFromServer: (server) => experimentHashFromServer(server),

  hash: experimentHash,
  isStale: (spec, server, current) =>
    experimentCohortRefsStale(
      spec,
      server,
      (current.get(cohortResource.name) ?? []) as ServerCohort[],
    ),
  validate: (specs, state) => validateExperiments(specs, state),
  executeOp: runExperimentOp,
  prune: pruneExperiment,

  displaySpec: (spec, _ctx: ApplyContext) => displayExperiment(spec),
  displayServer: (server, ctx: ApplyContext) => displayExperimentFromServer(server, ctx),

  listAll: listExperiments,
  getById: (config, id, options) => getExperiment(config, Number(id), options),
  hydrateForPull: (config, server, options) => getExperiment(config, server.id, options),
  pullFilter,
  pullLabel,
  serverIdOf,
  pullDependencies,
  renderToFile,
  tagOnServer,
};
