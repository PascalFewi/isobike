/**
 * MapLibre style + data-driven expressions for the effort field and the route.
 *
 * The effort colouring is a join: the Worker's `(edge_id -> time, cum_ascent)`
 * field is pushed onto the PMTiles line features via `setFeatureState` (the
 * source uses `promoteId` so `edge_id` becomes the feature id), and the paint
 * expressions read `feature-state`.
 *
 * Fitness and the budget change only these *expressions* (a cheap
 * `setPaintProperty`), never the feature-state and never a Worker call -- the raw
 * Worker time stays in feature-state and the band thresholds are scaled instead.
 */

import type {
  ExpressionSpecification,
  LineLayerSpecification,
  StyleSpecification,
} from 'maplibre-gl';

import { BAND_BOUNDS_S, PALETTE } from './colorScale.ts';
import { widthStops } from './mapWidth.ts';
import { DEFAULT_BUDGET_S, PMTILES_URL, REFERENCE_LAT, TILE_LAYER } from '../config.ts';

export const EFFORT_SOURCE = 'network';
export const EFFORT_LAYER = 'effort';
export const ASCENT_LAYER = 'effort-ascent';
export const ROUTE_LAYER = 'route';

const TRANSPARENT = 'rgba(0,0,0,0)';

/**
 * `line-color` for the effort layer: a step over `feature-state.time`, with the
 * band thresholds scaled by the Fitness factor (fitter -> same colour reached at
 * a larger raw time). Edges with no field entry render transparent.
 */
export function effortColorExpression(fitnessFactor: number): ExpressionSpecification {
  const step: unknown[] = ['step', ['feature-state', 'time'], PALETTE[0]];
  for (let i = 0; i < BAND_BOUNDS_S.length; i++) {
    step.push(BAND_BOUNDS_S[i] * fitnessFactor, PALETTE[i + 1]);
  }
  return [
    'case',
    ['==', ['feature-state', 'time'], null],
    TRANSPARENT,
    step as unknown as ExpressionSpecification,
  ] as unknown as ExpressionSpecification;
}

/** `line-width`: a fixed 200 m on the ground, zoom-interpolated, floored at 2 px. */
export function effortWidthExpression(meters = 200): ExpressionSpecification {
  const stops = widthStops(meters, REFERENCE_LAT);
  const expr: unknown[] = ['interpolate', ['exponential', 2], ['zoom']];
  for (const [z, px] of stops) expr.push(z, px);
  return expr as unknown as ExpressionSpecification;
}

/**
 * `line-opacity` for the effort layer: hide edges with no field entry, and hide
 * edges whose *displayed* reach time exceeds the client-side budget. Both budget
 * and Fitness change only this expression -- no Worker call. `budgetDisplayS` is
 * the budget in displayed seconds; the raw feature-state time is compared against
 * `budgetDisplayS * fitnessFactor` (displayed = raw / fitness).
 */
export function effortOpacityExpression(
  budgetDisplayS: number,
  fitnessFactor: number,
  base = 0.85,
): ExpressionSpecification {
  return [
    'case',
    ['==', ['feature-state', 'time'], null],
    0,
    ['>', ['feature-state', 'time'], budgetDisplayS * fitnessFactor],
    0,
    base,
  ] as unknown as ExpressionSpecification;
}

/** Second channel: a dark overlay whose opacity grows with cumulative ascent. */
export function ascentOpacityExpression(maxCumAscent: number): ExpressionSpecification {
  const denom = maxCumAscent > 0 ? maxCumAscent : 1;
  return [
    'case',
    ['==', ['feature-state', 'cumAscent'], null],
    0,
    ['min', 0.55, ['/', ['feature-state', 'cumAscent'], denom]],
  ] as unknown as ExpressionSpecification;
}

export function effortLayer(fitnessFactor: number): LineLayerSpecification {
  return {
    id: EFFORT_LAYER,
    type: 'line',
    source: EFFORT_SOURCE,
    'source-layer': TILE_LAYER,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': effortColorExpression(fitnessFactor),
      'line-width': effortWidthExpression(),
      'line-opacity': effortOpacityExpression(DEFAULT_BUDGET_S, fitnessFactor),
    },
  };
}

export function ascentLayer(maxCumAscent: number): LineLayerSpecification {
  return {
    id: ASCENT_LAYER,
    type: 'line',
    source: EFFORT_SOURCE,
    'source-layer': TILE_LAYER,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#1a1a1a',
      'line-width': effortWidthExpression(70), // thinner than the effort corridor
      'line-opacity': ascentOpacityExpression(maxCumAscent),
    },
  };
}

/**
 * The route reuses the PMTiles geometry: `/route` returns `edge_id`s, so we set
 * `feature-state.onRoute` for those edges and colour them, rather than shipping
 * geometry back from the Worker. MapLibre filters cannot read feature-state, so
 * the layer draws every edge but paints only the route ones (rest transparent).
 */
export function routeLayer(): LineLayerSpecification {
  return {
    id: ROUTE_LAYER,
    type: 'line',
    source: EFFORT_SOURCE,
    'source-layer': TILE_LAYER,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': [
        'case',
        ['==', ['feature-state', 'onRoute'], true],
        '#e6194b',
        TRANSPARENT,
      ] as unknown as ExpressionSpecification,
      'line-width': 4,
      'line-opacity': 0.95,
    },
  };
}

/**
 * swisstopo grey national map (`ch.swisstopo.pixelkarte-grau`): greyscale, so the
 * viridis effort colours dominate, but with the Swiss relief hillshade + contours
 * + topographic detail for real orientation -- the middle ground between a busy
 * colour map and a flat grey one. Free, no key; CH coverage (all v1 needs).
 *
 * Alternatives (swap `BASEMAP_TILES`/attribution):
 *   flat minimal (global) : https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png  (+ b,c,d)
 *   full-colour terrain   : https://a.tile.opentopomap.org/{z}/{x}/{y}.png            (+ b,c)
 */
const BASEMAP_TILES = [
  'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg',
];
const BASEMAP_MAXZOOM = 19;
const BASEMAP_ATTRIBUTION =
  '© <a href="https://www.swisstopo.admin.ch" target="_blank" rel="noreferrer">swisstopo</a>';

/**
 * The base style: a muted greyscale basemap for orientation, plus the PMTiles
 * network source. The effort-colouring line layers are added on top at runtime
 * (see MapView), so they overlay the basemap.
 */
export function buildStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      basemap: {
        type: 'raster',
        tiles: BASEMAP_TILES,
        tileSize: 256,
        maxzoom: BASEMAP_MAXZOOM,
        attribution: BASEMAP_ATTRIBUTION,
      },
      [EFFORT_SOURCE]: {
        type: 'vector',
        url: `pmtiles://${PMTILES_URL}`,
        // edge_id becomes the feature id so setFeatureState can target it.
        promoteId: { [TILE_LAYER]: 'edge_id' },
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#eef1f4' } },
      { id: 'basemap', type: 'raster', source: 'basemap' },
    ],
  };
}
