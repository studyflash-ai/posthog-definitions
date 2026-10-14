import type { ApplyContext, CollectionResourceModule } from "../types.js";
import type { HogFunction } from "./sdk.js";
import {
  HOG_FUNCTION_IDENTITY_PREFIX,
  displayHogFunction,
  displayHogFunctionFromServer,
  hogFunctionHash,
  hogFunctionHashFromServer,
  hogFunctionKeyFromServer,
  looksLikeHogFunction,
  pruneHogFunction,
  runHogFunctionOp,
  validateHogFunctions,
} from "./pipeline.js";
import { getHogFunction, listManagedHogFunctions, type ServerHogFunction } from "./client.js";

export { hogFunction } from "./sdk.js";
export type {
  HogFunction,
  HogFunctionInputSchema,
  HogFunctionMapping,
  HogFunctionType,
} from "./sdk.js";

export const hogFunctionResource: CollectionResourceModule<HogFunction, ServerHogFunction> = {
  kind: "collection",
  name: "hog-functions",
  displayName: "hog function",
  identityPrefix: HOG_FUNCTION_IDENTITY_PREFIX,

  isSpec: looksLikeHogFunction,
  specKey: (spec) => spec.key,

  // List rows omit inputs and mappings; managed rows are few, so fetch each in full for the plan.
  list: async (config, options) => {
    const rows = await listManagedHogFunctions(config, options);
    return Promise.all(rows.map((row) => getHogFunction(config, row.id, options)));
  },
  keyFromServer: (server) => hogFunctionKeyFromServer(server),
  hashFromServer: (server) => hogFunctionHashFromServer(server),

  hash: hogFunctionHash,
  validate: (specs) => validateHogFunctions(specs),
  executeOp: runHogFunctionOp,
  prune: pruneHogFunction,

  displaySpec: (spec, _ctx: ApplyContext) => displayHogFunction(spec),
  displayServer: (server, _ctx: ApplyContext) => displayHogFunctionFromServer(server),
};
