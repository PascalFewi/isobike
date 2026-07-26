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
 * The base style: a plain background plus the PMTiles network source. A basemap
 * (raster or vector) can be layered in via config for orientation; v1 keeps the
 * network the sole content so the effort colouring reads cleanly.
 */
export function buildStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      [EFFORT_SOURCE]: {
        type: 'vector',
        url: `pmtiles://${PMTILES_URL}`,
        // edge_id becomes the feature id so setFeatureState can target it.
        promoteId: { [TILE_LAYER]: 'edge_id' },
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#eef1f4' } },
    ],
  };
}
