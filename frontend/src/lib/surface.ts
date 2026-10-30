/**
 * The route's surface, like komoot's way-type breakdown: how many km are asphalt,
 * gravel or natural path, and where along the line each stretch lies.
 *
 * The Worker sends both per leg: `surface_m` (metres per class) and
 * `geometry_surface`, runs `[first vertex, class]` along the leg's polyline.
 * {@link joinLegs} glues the legs into the one line the map, the GPX and the
 * elevation profile use, and carries the surface along vertex by vertex.
 */

import type { RouteResult } from './api.ts';
import type { Coord } from './gpx.ts';

/** Display order, best for a road bike first. */
export const SURFACES = ['paved', 'gravel', 'unpaved', 'unknown'] as const;
export type SurfaceKey = (typeof SURFACES)[number];

/** Surface class ids as the Worker numbers them (its `Surface` enum). */
const BY_CLASS: readonly SurfaceKey[] = ['unknown', 'paved', 'gravel', 'unpaved'];

/** Colours match the road-type layer's (mapStyle.ts) where the meaning is the same. */
export const SURFACE_INFO: Readonly<Record<SurfaceKey, { readonly label: string; readonly color: string }>> = {
  paved: { label: 'Asphalt', color: '#546e7a' },
  gravel: { label: 'Schotter', color: '#8d6e63' },
  unpaved: { label: 'Naturweg', color: '#5d4037' },
  unknown: { label: 'Unbekannt', color: '#cfd8dc' },
};

export const surfaceOfClass = (cls: number): SurfaceKey => BY_CLASS[cls] ?? 'unknown';

export interface JoinedRoute {
  /** All found legs' polylines as one, junction vertices once. */
  readonly coords: Coord[];
  /** Vertex index where each leg ends (one per leg, found or not). */
  readonly stops: number[];
  /** Surface class of the stretch starting at each vertex; unknown where not sent. */
  readonly surfaceAt: Uint8Array;
}

export function joinLegs(legs: ReadonlyArray<RouteResult | null>): JoinedRoute {
  const coords: Coord[] = [];
  const stops: number[] = [];
  const classes: number[] = [];
  for (const l of legs) {
    const g = l?.found ? l.geometry : undefined;
    if (g !== undefined && g.length > 0) {
      // Leg vertex j lands at `at(j)`: a later leg's first vertex is the junction already there.
      const base = coords.length === 0 ? 0 : coords.length - 1;
      coords.push(...(coords.length === 0 ? g : g.slice(1)));
      while (classes.length < coords.length) classes.push(0);
      const runs = l?.geometry_surface ?? [];
      runs.forEach(([start, cls], k) => {
        const end = k + 1 < runs.length ? runs[k + 1][0] : g.length - 1;
        for (let j = start; j < end; j++) classes[base + j] = cls;
      });
    }
    stops.push(Math.max(0, coords.length - 1));
  }
  return { coords, stops, surfaceAt: Uint8Array.from(classes) };
}

/** Metres per surface over the found legs. */
export function surfaceTotals(legs: ReadonlyArray<RouteResult | null>): Record<SurfaceKey, number> {
  const out: Record<SurfaceKey, number> = { paved: 0, gravel: 0, unpaved: 0, unknown: 0 };
  for (const l of legs) {
    if (!l?.found || l.surface_m === undefined) continue;
    for (const k of SURFACES) out[k] += l.surface_m[k] ?? 0;
  }
  return out;
}
