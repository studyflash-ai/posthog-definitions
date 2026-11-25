import type { ClientConfig } from "../../client/config.js";
import { externalDataSourceResource } from "../external-data-source/index.js";
import type { ApplyContext, CollectionResourceModule } from "../types.js";
import type { EltDestination } from "./sdk.js";
import {
  displayEltDestination,
  displayEltDestinationFromServer,
  ELT_DESTINATION_IDENTITY_PREFIX,
  eltDestinationHash,
  eltDestinationHashFromServer,
  eltDestinationKeyFromServer,
  linkedTables,
  looksLikeEltDestination,
  pruneEltDestination,
  runEltDestinationOp,
  validateEltDestinations,
} from "./pipeline.js";
import { listEltDestinations, type ServerEltDestination } from "./client.js";

export { eltDestination } from "./sdk.js";
export type { EltDestination, EltDestinationTable, EltDestinationType } from "./sdk.js";

/** Managed destinations only, each with the tables linked to it read in. */
async function listManagedDestinations(
  config: ClientConfig,
  options: { verbose?: boolean } = {},
): Promise<ServerEltDestination[]> {
  const managed = (await listEltDestinations(config, options)).filter(
    (row) => eltDestinationKeyFromServer(row) !== undefined,
  );
  return Promise.all(
    managed.map(async (row) => ({
      ...row,
      linked_tables: await linkedTables(config, row, options),
    })),
  );
}

export const eltDestinationResource: CollectionResourceModule<
  EltDestination,
  ServerEltDestination
> = {
  kind: "collection",
  name: "elt-destinations",
  displayName: "ELT destination",
  identityPrefix: ELT_DESTINATION_IDENTITY_PREFIX,
  dependsOn: [externalDataSourceResource],

  isSpec: looksLikeEltDestination,
  specKey: (spec) => spec.key,

  list: listManagedDestinations,
  keyFromServer: eltDestinationKeyFromServer,
  hashFromServer: eltDestinationHashFromServer,

  hash: eltDestinationHash,
  /**
   * The hash covers which tables link here, so a table someone detached in
   * PostHog still counts as drift.
   */
  isStale: (spec, server) =>
    JSON.stringify(spec.tables.map((t) => `${t.source.key}/${t.schema}`).sort()) !==
    JSON.stringify(server.linked_tables ?? []),
  validate: (specs, state) => validateEltDestinations(specs, state),
  executeOp: runEltDestinationOp,
  prune: pruneEltDestination,

  displaySpec: (spec, _ctx: ApplyContext) => displayEltDestination(spec),
  displayServer: (server, _ctx: ApplyContext) => displayEltDestinationFromServer(server),
};
