/**
 * Worker API client. Builds requests, sends profile speeds in m/s (the Worker's
 * units), and parses the responses.
 *
 * Note what does and does not go on the wire: the Profil speeds and the surface
 * / slope filters DO (they change the route), the Fitness factor does NOT -- it is
 * a client-side rescale (see profile.ts). Keeping that boundary here is what makes
 * the Fitness slider instant.
 */

import { WORKER_URL, DEFAULT_BUDGET_S } from '../config.ts';
import { parseEffortField, type EffortField } from './effortResponse.ts';
import type { Speeds } from './profile.ts';

/** Surface class ids, matching the Worker's `Surface` enum. */
export const Surface = { Unknown: 0, Paved: 1, Gravel: 2, Unpaved: 3 } as const;

export interface FilterOptions {
  /** Max uphill grade in percent; undefined = no slope filter. */
  readonly maxSlopePct?: number;
  /** Allowed surface class ids; undefined = all surfaces (road+gravel). */
  readonly surfaces?: readonly number[];
}

export interface SnapResult {
  readonly node: number;
  readonly lat: number;
  readonly lon: number;
}

export interface RouteResult {
  readonly found: boolean;
  readonly from_snapped: SnapResult;
  readonly to_snapped: SnapResult;
  readonly cost_s?: number;
  readonly dist_m?: number;
  readonly ascent_m?: number;
  readonly descent_m?: number;
  readonly max_slope_pct?: number;
  readonly edge_ids?: number[];
  readonly nodes?: number[];
}

export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

function filterBody(filters: FilterOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (filters.maxSlopePct !== undefined) body.max_slope = filters.maxSlopePct;
  if (filters.surfaces !== undefined) body.surfaces = filters.surfaces;
  return body;
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** `GET /snap` -> nearest graph node. */
export async function snap(at: LatLon): Promise<SnapResult> {
  const res = await fetch(`${WORKER_URL}/snap?lat=${at.lat}&lon=${at.lon}`);
  if (!res.ok) throw new Error(`snap failed: ${res.status}`);
  return (await res.json()) as SnapResult;
}

/**
 * `POST /effort-field` -> binary reachability field. Uses the Profil speeds and
 * the default time budget; the Fitness factor is applied afterwards, client-side.
 */
export async function effortField(
  at: LatLon,
  speeds: Speeds,
  filters: FilterOptions = {},
  budgetS: number = DEFAULT_BUDGET_S,
): Promise<EffortField> {
  const body = {
    lat: at.lat,
    lon: at.lon,
    v_flat: speeds.vFlatMps,
    vam: speeds.vamMps,
    max_cost: budgetS,
    ...filterBody(filters),
  };
  const res = await fetch(`${WORKER_URL}/effort-field`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`effort-field failed: ${res.status} ${await res.text()}`);
  return parseEffortField(await res.arrayBuffer());
}

/** `POST /route` -> a route with summed stats, or `{found:false}`. */
export async function route(
  from: LatLon,
  to: LatLon,
  speeds: Speeds,
  filters: FilterOptions = {},
): Promise<RouteResult> {
  const body = {
    from: [from.lat, from.lon],
    to: [to.lat, to.lon],
    v_flat: speeds.vFlatMps,
    vam: speeds.vamMps,
    ...filterBody(filters),
  };
  return (await postJson('/route', body)) as RouteResult;
}
