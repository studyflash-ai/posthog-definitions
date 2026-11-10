import type { ClientConfig } from "../../client/config.js";
import { ApiError } from "../../client/typed.js";
import { specHash } from "../../apply/hash.js";
import {
  arr,
  displayJson,
  filterUserTags,
  obj,
  scalar,
  type DisplayValue,
} from "../../apply/display.js";
import { SafetyViolationError } from "../../apply/errors.js";
import {
  getResourceKind,
  type ApplyContext,
  type DesiredState,
  type ResourceOp,
} from "../types.js";
import type { Insight } from "../insight/sdk.js";
import { getInsight, setInsightDashboards, type ServerInsight } from "../insight/client.js";
import { insightKeyFromTags } from "../insight/pipeline.js";
import {
  type ButtonTile,
  type Dashboard,
  type InsightTile,
  isButtonTile,
  isInsightTile,
  isTextTile,
  type Layout,
  type TextTile,
  type Tile,
} from "./sdk.js";
import {
  createDashboard,
  deleteDashboard,
  getDashboard,
  type ServerDashboard,
  type ServerTile,
  updateDashboard,
} from "./client.js";

export const DASHBOARD_TAG_PREFIX = "iac:dashboards:";
export const HASH_TAG_PREFIX = "iac:hash:";

const RESTRICTION_TO_LEVEL: Record<NonNullable<Dashboard["restriction"]>, number> = {
  everyone: 21,
  collaborators: 37,
};
const GRID_WIDTH = 12;

export function dashboardTag(key: string): string {
  return `${DASHBOARD_TAG_PREFIX}${key}`;
}

export function dashboardKeyFromTags(tags: string[] | undefined): string | undefined {
  const tag = tags?.find((t) => t.startsWith(DASHBOARD_TAG_PREFIX));
  return tag?.slice(DASHBOARD_TAG_PREFIX.length);
}

export function dashboardHashFromTags(tags: string[] | undefined): string | undefined {
  return tags?.find((t) => t.startsWith(HASH_TAG_PREFIX))?.slice(HASH_TAG_PREFIX.length);
}

function hashTag(hex: string): string {
  return `${HASH_TAG_PREFIX}${hex}`;
}

function mergeTags(userTags: string[] | undefined, managedTags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of managedTags) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  for (const tag of userTags ?? []) {
    if (tag.startsWith("iac:")) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

function dashboardSpecForHash(spec: Dashboard): unknown {
  return {
    key: spec.key,
    name: spec.name,
    description: spec.description ?? null,
    pinned: spec.pinned ?? false,
    restriction: spec.restriction,
    tags: spec.tags ?? [],
    tiles: spec.tiles.map((tile) => {
      if (isInsightTile(tile)) {
        return {
          kind: "insight",
          insightKey: tile.insight.key,
          layout: tile.layout,
          color: tile.color,
          filtersOverride: tile.filtersOverride,
        };
      }
      return tile;
    }),
  };
}

export function dashboardHash(spec: Dashboard): string {
  return specHash(dashboardSpecForHash(spec));
}

function layoutsFor(layout: Layout): Record<string, Layout> {
  return { sm: layout, lg: layout };
}

function insightIdFor(tile: InsightTile, insightIdByKey: Map<string, number>): number {
  const id = insightIdByKey.get(tile.insight.key);
  if (id === undefined) {
    throw new Error(
      `Insight "${tile.insight.key}" was not created before its dashboard tile. This is a bug in the executor ordering.`,
    );
  }
  return id;
}

function tileBody(tile: TextTile | ButtonTile): string {
  return isTextTile(tile) ? tile.body : `[${tile.text}](${tile.url})`;
}

function liveTiles(server: ServerDashboard): ServerTile[] {
  return (server.tiles ?? []).filter((t) => !t.deleted);
}

export function dashboardPayload(
  spec: Dashboard,
  hash: string,
): {
  name: string;
  description: string | null;
  pinned: boolean;
  tags: string[];
  restriction_level?: number;
} {
  return {
    name: spec.name,
    description: spec.description ?? null,
    pinned: spec.pinned ?? false,
    tags: mergeTags(spec.tags, [dashboardTag(spec.key), hashTag(hash)]),
    ...(spec.restriction !== undefined && {
      restriction_level: RESTRICTION_TO_LEVEL[spec.restriction],
    }),
  };
}

/**
 * PostHog ignores `tiles` on a dashboard POST, and a dashboard PATCH only edits tiles it
 * gets by id (or creates text tiles). An insight tile exists only once the insight's
 * `dashboards` list holds the dashboard. So: link the missing insights, then set every
 * tile's layout by id, create missing text tiles, and delete tiles the spec dropped.
 */
async function syncTiles(
  config: ClientConfig,
  dashboardId: number,
  spec: Dashboard,
  insightIdByKey: Map<string, number>,
  options: { verbose?: boolean },
): Promise<void> {
  const before = liveTiles(await getDashboard(config, dashboardId, options));
  const linked = new Set(before.flatMap((t) => (t.insight ? [t.insight.id] : [])));
  for (const tile of spec.tiles) {
    if (!isInsightTile(tile)) continue;
    const id = insightIdFor(tile, insightIdByKey);
    if (linked.has(id)) continue;
    const insight = await getInsight(config, id, options);
    await setInsightDashboards(
      config,
      id,
      [...new Set([...(insight.dashboards ?? []), dashboardId])],
      options,
    );
    linked.add(id);
  }

  const current = liveTiles(await getDashboard(config, dashboardId, options));
  const unclaimed = new Set(current);
  const claim = (match: (t: ServerTile) => boolean): ServerTile | undefined => {
    const found = current.find((t) => unclaimed.has(t) && match(t));
    if (found) unclaimed.delete(found);
    return found;
  };
  const tiles: unknown[] = [];
  for (const tile of spec.tiles) {
    if (isInsightTile(tile)) {
      const id = insightIdFor(tile, insightIdByKey);
      const server = claim((t) => t.insight?.id === id);
      if (!server) {
        throw new Error(
          `Insight "${tile.insight.key}" has no tile on dashboard ${dashboardId} after linking it.`,
        );
      }
      tiles.push({
        id: server.id,
        layouts: layoutsFor(tile.layout),
        ...(tile.color !== undefined && { color: tile.color }),
        ...(tile.filtersOverride !== undefined && { filters_overrides: tile.filtersOverride }),
      });
      continue;
    }
    const body = tileBody(tile);
    const server = claim((t) => t.text?.body === body);
    tiles.push(
      server
        ? { id: server.id, layouts: layoutsFor(tile.layout) }
        : { text: { body }, layouts: layoutsFor(tile.layout) },
    );
  }
  for (const t of unclaimed) tiles.push({ id: t.id, deleted: true });
  await updateDashboard(config, dashboardId, { tiles }, options);
}

/** The hash covers the spec, not the server: a dashboard whose tiles never landed still matches it. */
export function dashboardTilesStale(
  spec: Dashboard,
  server: ServerDashboard,
  insights: readonly unknown[],
): boolean {
  if (server.tiles === undefined) return false;
  const insightIdByKey = new Map<string, number>();
  for (const insight of insights.filter(isInsightRow)) {
    const key = insightKeyFromTags(insight.tags);
    if (key) insightIdByKey.set(key, insight.id);
  }
  const want = spec.tiles
    .map((t) => (isInsightTile(t) ? `i:${insightIdByKey.get(t.insight.key)}` : `t:${tileBody(t)}`))
    .sort();
  const have = liveTiles(server)
    .map((t) => (t.insight ? `i:${t.insight.id}` : `t:${t.text?.body}`))
    .sort();
  return want.length !== have.length || want.some((w, i) => w !== have[i]);
}

export function looksLikeDashboard(value: unknown): value is Dashboard {
  const kind = getResourceKind(value);
  if (kind !== undefined) return kind === "dashboard";
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.key === "string" && typeof v.name === "string" && Array.isArray(v.tiles);
}

function validateLayout(issues: string[], where: string, layout: Layout | undefined): void {
  if (!layout) {
    issues.push(`${where}: layout is required`);
    return;
  }
  if (layout.x < 0 || layout.y < 0) issues.push(`${where}: layout x/y must be >= 0`);
  if (layout.w <= 0 || layout.h <= 0) issues.push(`${where}: layout w/h must be > 0`);
  if (layout.x + layout.w > GRID_WIDTH) {
    issues.push(
      `${where}: layout overflows the ${GRID_WIDTH}-column grid (x=${layout.x}, w=${layout.w})`,
    );
  }
}

function validateTile(
  issues: string[],
  dashboardKey: string,
  index: number,
  tile: Tile,
  knownInsightKeys: Set<string>,
): void {
  const where = `dashboard "${dashboardKey}" tile[${index}]`;
  if (isInsightTile(tile)) {
    if (!tile.insight) issues.push(`${where}: missing insight`);
    else if (!knownInsightKeys.has(tile.insight.key)) {
      issues.push(`${where}: references unknown insight "${tile.insight.key}"`);
    }
    validateLayout(issues, where, tile.layout);
  } else if (isTextTile(tile)) {
    if (!tile.body) issues.push(`${where}: text tile body is empty`);
    validateLayout(issues, where, tile.layout);
  } else if (isButtonTile(tile)) {
    if (!tile.url) issues.push(`${where}: button tile url is empty`);
    if (!tile.text) issues.push(`${where}: button tile text is empty`);
    validateLayout(issues, where, tile.layout);
  } else {
    issues.push(`${where}: unknown tile shape`);
  }
}

export function validateDashboards(specs: Dashboard[], state: DesiredState): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const knownInsightKeys = new Set<string>();
  for (const loaded of state.get("insights") ?? []) {
    knownInsightKeys.add((loaded.spec as Insight).key);
  }
  for (const spec of specs) {
    if (!spec.key) issues.push("dashboard.key is required");
    if (!spec.name) issues.push(`dashboard "${spec.key}" name is required`);
    if (!spec.tiles || spec.tiles.length === 0) {
      issues.push(`dashboard "${spec.key}" must have at least one tile`);
    } else {
      spec.tiles.forEach((tile, i) => validateTile(issues, spec.key, i, tile, knownInsightKeys));
    }
    if (seen.has(spec.key)) issues.push(`Duplicate dashboard key "${spec.key}"`);
    seen.add(spec.key);
  }
  return issues;
}

export function extractInlineInsights(
  spec: Dashboard,
): Array<{ resourceName: string; spec: unknown }> {
  const out: Array<{ resourceName: string; spec: unknown }> = [];
  for (const tile of spec.tiles) {
    if (isInsightTile(tile)) {
      out.push({ resourceName: "insights", spec: tile.insight });
    }
  }
  return out;
}

async function assertManagedDashboard(
  config: ClientConfig,
  id: number,
  key: string,
  options: { verbose?: boolean },
): Promise<void> {
  const current = await getDashboard(config, id, options);
  if (!current.tags?.includes(dashboardTag(key))) {
    throw new SafetyViolationError("dashboard", id, key);
  }
}

export async function runDashboardOp(
  config: ClientConfig,
  op: ResourceOp<Dashboard, ServerDashboard>,
  ctx: ApplyContext,
  options: { verbose?: boolean } = {},
): Promise<void> {
  if (op.kind === "unchanged") return;

  const payload = dashboardPayload(op.spec, dashboardHash(op.spec));

  let dashboardId: number;
  if (op.kind === "create") {
    dashboardId = (await createDashboard(config, payload, options)).id;
  } else {
    await assertManagedDashboard(config, op.server.id, op.spec.key, options);
    await updateDashboard(config, op.server.id, payload, options);
    dashboardId = op.server.id;
  }
  await syncTiles(config, dashboardId, op.spec, ctx.insightIdByKey, options);
}

export async function pruneDashboard(
  config: ClientConfig,
  orphan: ServerDashboard,
  options: { verbose?: boolean } = {},
): Promise<boolean> {
  const key = dashboardKeyFromTags(orphan.tags) ?? `id:${orphan.id}`;
  try {
    await assertManagedDashboard(config, orphan.id, key, options);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false;
    throw err;
  }
  await deleteDashboard(config, orphan.id, options);
  return true;
}

function pickLayout(layouts: ServerTile["layouts"]): unknown {
  if (!layouts) return null;
  return layouts.sm ?? layouts.lg ?? Object.values(layouts)[0] ?? null;
}

function parseMarkdownButton(body: string): { text: string; url: string } | null {
  const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(body.trim());
  if (!match) return null;
  return { text: match[1]!, url: match[2]! };
}

function restrictionFromLevel(level: number | undefined): string | null {
  if (level === 37) return "collaborators";
  if (level === 21) return "everyone";
  return null;
}

function displayTileSpec(tile: Tile): DisplayValue {
  if (isInsightTile(tile)) {
    return obj([
      ["kind", scalar("insight")],
      ["insightKey", scalar(tile.insight.key)],
      ["layout", displayJson(tile.layout)],
      ...(tile.color !== undefined
        ? ([["color", scalar(tile.color)]] as Array<[string, DisplayValue]>)
        : []),
    ]);
  }
  if (isTextTile(tile)) {
    return obj([
      ["kind", scalar("text")],
      ["body", scalar(tile.body)],
      ["layout", displayJson(tile.layout)],
    ]);
  }
  if (isButtonTile(tile)) {
    return obj([
      ["kind", scalar("button")],
      ["text", scalar(tile.text)],
      ["url", scalar(tile.url)],
      ["layout", displayJson(tile.layout)],
    ]);
  }
  return scalar(JSON.stringify(tile));
}

function displayServerTile(
  tile: ServerTile,
  insightKeyByServerId: Map<number, string>,
): DisplayValue {
  if (tile.insight && typeof tile.insight.id === "number") {
    const key = insightKeyByServerId.get(tile.insight.id) ?? `id:${tile.insight.id}`;
    return obj([
      ["kind", scalar("insight")],
      ["insightKey", scalar(key)],
      ["layout", displayJson(pickLayout(tile.layouts))],
      ...(tile.color != null
        ? ([["color", scalar(tile.color)]] as Array<[string, DisplayValue]>)
        : []),
    ]);
  }
  if (tile.text && typeof tile.text.body === "string") {
    const button = parseMarkdownButton(tile.text.body);
    if (button) {
      return obj([
        ["kind", scalar("button")],
        ["text", scalar(button.text)],
        ["url", scalar(button.url)],
        ["layout", displayJson(pickLayout(tile.layouts))],
      ]);
    }
    return obj([
      ["kind", scalar("text")],
      ["body", scalar(tile.text.body)],
      ["layout", displayJson(pickLayout(tile.layouts))],
    ]);
  }
  return scalar(JSON.stringify(tile));
}

export function displayDashboard(spec: Dashboard): DisplayValue {
  return obj([
    ["name", scalar(spec.name)],
    ["description", scalar(spec.description ?? null)],
    ["pinned", scalar(spec.pinned ?? false)],
    ["restriction", scalar(spec.restriction ?? null)],
    ["tags", arr(filterUserTags(spec.tags).map(scalar))],
    ["tiles", arr(spec.tiles.map(displayTileSpec))],
  ]);
}

export function displayDashboardFromServer(
  server: ServerDashboard,
  insightKeyByServerId: Map<number, string>,
): DisplayValue {
  return obj([
    ["name", scalar(server.name)],
    ["description", scalar(server.description ?? null)],
    ["pinned", scalar(server.pinned ?? false)],
    ["restriction", scalar(restrictionFromLevel(server.restriction_level))],
    ["tags", arr(filterUserTags(server.tags).map(scalar))],
    ["tiles", arr((server.tiles ?? []).map((t) => displayServerTile(t, insightKeyByServerId)))],
  ]);
}

function isInsightRow(row: unknown): row is Pick<ServerInsight, "id" | "tags"> {
  if (typeof row !== "object" || row === null) return false;
  if (!("id" in row) || typeof row.id !== "number") return false;
  return "tags" in row && Array.isArray(row.tags) && row.tags.every((t) => typeof t === "string");
}
