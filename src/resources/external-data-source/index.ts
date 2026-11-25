import type { ApplyContext, CollectionResourceModule } from "../types.js";
import type { ExternalDataSource } from "./sdk.js";
import {
  displayExternalDataSource,
  displayExternalDataSourceFromServer,
  EXTERNAL_DATA_SOURCE_IDENTITY_PREFIX,
  externalDataSourceAdoptionKey,
  externalDataSourceAdoptionKeyFromServer,
  externalDataSourceHash,
  externalDataSourceHashFromServer,
  externalDataSourceKeyFromServer,
  looksLikeExternalDataSource,
  pruneExternalDataSource,
  runExternalDataSourceOp,
  validateExternalDataSources,
} from "./pipeline.js";
import {
  getExternalDataSource,
  listExternalDataSources,
  type ServerExternalDataSource,
} from "./client.js";

export { externalDataSource } from "./sdk.js";
export type {
  ExternalDataSource,
  ExternalDataSchema,
  ExternalDataSchemaSyncFrequency,
  ExternalDataSchemaSyncType,
} from "./sdk.js";

/**
 * Every source in the project, each read on its own: the list endpoint trims
 * its tables to a few fields, and the plan compares incremental fields too.
 * Unmanaged sources are kept so a spec can adopt the one with its type and prefix.
 */
async function listSources(
  config: Parameters<typeof listExternalDataSources>[0],
  options: { verbose?: boolean } = {},
): Promise<ServerExternalDataSource[]> {
  const rows = await listExternalDataSources(config, options);
  return Promise.all(rows.map((row) => getExternalDataSource(config, row.id, options)));
}

export const externalDataSourceResource: CollectionResourceModule<
  ExternalDataSource,
  ServerExternalDataSource
> = {
  kind: "collection",
  name: "external-data-sources",
  displayName: "external data source",
  identityPrefix: EXTERNAL_DATA_SOURCE_IDENTITY_PREFIX,

  isSpec: looksLikeExternalDataSource,
  specKey: (spec) => spec.key,

  list: listSources,
  keyFromServer: externalDataSourceKeyFromServer,
  hashFromServer: externalDataSourceHashFromServer,
  adoptionKey: externalDataSourceAdoptionKey,
  adoptionKeyFromServer: externalDataSourceAdoptionKeyFromServer,

  hash: externalDataSourceHash,
  validate: (specs) => validateExternalDataSources(specs),
  executeOp: runExternalDataSourceOp,
  prune: (_config, orphan) => pruneExternalDataSource(orphan),

  displaySpec: (spec, _ctx: ApplyContext) => displayExternalDataSource(spec),
  displayServer: (server, _ctx: ApplyContext) => displayExternalDataSourceFromServer(server),
};
