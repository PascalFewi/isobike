/**
 * MapLibre style + data-driven expressions for the reach map and the route.
 *
 * Two display levels, because what reads well changes with scale:
 *
 *   zoom <= 11   isolines at the band edges over a soft area fill, both drawn
 *                from the Worker's 500 m min-time grid (see isolines.ts). A
 *                surface reads cleanly from country down to region scale; per-
 *                road colouring at these zooms looked dotted, because the low-
 *                zoom tiles carry only part of the roads and short edges render
 *                as blobs
 *   zoom >= 11   lines by road class: main roads bold, tracks and paths fine,
 *                with a light casing -- here the tiles are complete and the
 *                single road matters
 *
 * The road layers are a join: the Worker's `(edge_id -> time)` field is pushed
 * onto the PMTiles line features via `setFeatureState` (the source uses
 * `promoteId` so `edge_id` becomes the feature id), and the paint expressions
 * read `feature-state.time`. That time is in *Worker* seconds including the
 * route-leg offset; the rider's speed factor and the budget only change these
 * expressions (a cheap `setPaintProperty`), never the state, never a Worker call.
 */

import type {
  ExpressionSpecification,
  LineLayerSpecification,
  StyleSpecification,
} from 'maplibre-gl';

import { BAND_COLORS, N_BANDS, bandStepS } from './colorScale.ts';
import { PMTILES_URL, TILE_LAYER } from '../config.ts';

export const EFFORT_SOURCE = 'network';
export const ISO_FILL_SOURCE = 'iso-fill';
export const ISO_LINE_SOURCE = 'iso-lines';
export const ROUTE_SOURCE = 'route';
export const HOVER_SOURCE = 'hover';

export const ISO_FILL_LAYER = 'iso-fill';
export const ISO_LINE_LAYER = 'iso-lines';
export const CASING_LAYER = 'effort-casing';
export const LINE_LAYER = 'effort-line';
export const ROUTE_CASING_LAYER = 'route-casing';
export const ROUTE_LAYER = 'route-line';
export const HOVER_LAYER = 'hover-point';

/** Zoom where the isolines hand over to the road lines (cross-fade +-0.5). */
export const ISO_MAX_ZOOM = 11;
/** Zoom where the road lines are fully in. */
export const CLASS_ZOOM = ISO_MAX_ZOOM;
/** Below this zoom the road layers are invisible, so no feature-state is needed. */
export const STAMP_MIN_ZOOM = ISO_MAX_ZOOM - 1;

const TRANSPARENT = 'rgba(0,0,0,0)';

/** Road class from the tile's `highway` property: 0 main, 1 local, 2 track/path/cycleway. */
const ROAD_CLASS: ExpressionSpecification = [
  'match',
  ['get', 'highway'],
  ['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link'],
  0,
  ['unclassified', 'residential', 'living_street', 'service', 'road'],
  1,
  2,
];

const HAS_TIME = ['!=', ['feature-state', 'time'], null] as unknown as ExpressionSpecification;

/** In budget: set and below the budget in Worker seconds. */
function inBudget(budgetHours: number, factor: number): ExpressionSpecification {
  return ['all', HAS_TIME, ['<', ['feature-state', 'time'], budgetHours * 3600 * factor]];
}

/**
 * `line-color` for the road layers: a step over `feature-state.time`. Band edges
 * are displayed seconds times the speed factor, i.e. compared in Worker seconds
 * (displayed = worker / factor).
 */
export function effortColorExpression(budgetHours: number, factor: number): ExpressionSpecification {
  const step: unknown[] = ['step', ['feature-state', 'time'], BAND_COLORS[0]];
  const width = bandStepS(budgetHours) * factor;
  for (let k = 1; k < N_BANDS; k++) step.push(k * width, BAND_COLORS[k]);
  return ['case', HAS_TIME, step, TRANSPARENT] as unknown as ExpressionSpecification;
}

/** Road lines fade in as the isolines fade out. */
export function lineOpacityExpression(budgetHours: number, factor: number): ExpressionSpecification {
  const on: ExpressionSpecification = ['case', inBudget(budgetHours, factor), 1, 0];
  return [
    'interpolate', ['linear'], ['zoom'],
    CLASS_ZOOM - 0.5, 0,
    CLASS_ZOOM + 0.5, ['*', 0.95, on],
  ] as unknown as ExpressionSpecification;
}

export function casingOpacityExpression(budgetHours: number, factor: number): ExpressionSpecification {
  const on: ExpressionSpecification = ['case', inBudget(budgetHours, factor), 1, 0];
  return [
    'interpolate', ['linear'], ['zoom'],
    CLASS_ZOOM - 0.5, 0,
    CLASS_ZOOM + 0.5, ['*', 0.85, on],
  ] as unknown as ExpressionSpecification;
}

/** `line-width` by road class: a fine line mid-zoom, a road-map hierarchy close in. */
function classWidth(extra = 0): ExpressionSpecification {
  const byClass = (main: number, local: number, track: number): ExpressionSpecification =>
    ['match', ROAD_CLASS, 0, main + extra, 1, local + extra, track + extra] as unknown as ExpressionSpecification;
  return [
    'interpolate', ['exponential', 1.6], ['zoom'],
    11, byClass(2.4, 1.6, 1.0),
    13, byClass(4, 2.8, 1.6),
    16, byClass(10, 7, 3.5),
  ] as unknown as ExpressionSpecification;
}

function roadLayer(id: string, paint: LineLayerSpecification['paint'], minzoom: number): LineLayerSpecification {
  return {
    id,
    type: 'line',
    source: EFFORT_SOURCE,
    'source-layer': TILE_LAYER,
    minzoom,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: paint ?? {},
  };
}

/** The road layers in draw order (casing, line), styled for a budget and speed. */
export function roadLayers(budgetHours: number, factor: number): LineLayerSpecification[] {
  return [
    roadLayer(CASING_LAYER, {
      'line-color': '#ffffff',
      'line-width': classWidth(2),
      'line-opacity': casingOpacityExpression(budgetHours, factor),
    }, CLASS_ZOOM - 0.5),
    roadLayer(LINE_LAYER, {
      'line-color': effortColorExpression(budgetHours, factor),
      'line-width': classWidth(),
      'line-opacity': lineOpacityExpression(budgetHours, factor),
    }, CLASS_ZOOM - 0.5),
  ];
}

/** Restyle the road layers in place for a new budget / speed -- no state change. */
export function restyleRoads(
  map: { setPaintProperty(layer: string, prop: string, value: unknown): void },
  budgetHours: number,
  factor: number,
): void {
  map.setPaintProperty(CASING_LAYER, 'line-opacity', casingOpacityExpression(budgetHours, factor));
  map.setPaintProperty(LINE_LAYER, 'line-color', effortColorExpression(budgetHours, factor));
  map.setPaintProperty(LINE_LAYER, 'line-opacity', lineOpacityExpression(budgetHours, factor));
}

const SWISSTOPO = '© <a href="https://www.swisstopo.admin.ch" target="_blank" rel="noreferrer">swisstopo</a>';

/**
 * The selectable backgrounds. All are raster tiles in Web Mercator, free and
 * keyless; each is its own source + layer, and only the visible one loads tiles.
 *
 * - grau: swisstopo grey national map -- greyscale, so the reach colours
 *   dominate, with relief and topographic detail for orientation. CH only.
 * - satellit: swisstopo SWISSIMAGE aerial imagery, 10 cm - 2 m. CH only.
 * - osm: the OpenStreetMap standard map, worldwide. Served by the OSM
 *   Foundation's volunteer-run tile servers, whose usage policy allows light
 *   use with attribution; heavy traffic would need a commercial tile provider.
 */
export const BASEMAPS = {
  grau: {
    label: 'Grau',
    tiles: ['https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg'],
    maxzoom: 19,
    attribution: SWISSTOPO,
  },
  satellit: {
    label: 'Satellit',
    tiles: ['https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg'],
    maxzoom: 20,
    attribution: SWISSTOPO,
  },
  osm: {
    label: 'OSM',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    maxzoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>-Mitwirkende',
  },
} as const;

export type BasemapKey = keyof typeof BASEMAPS;
export const DEFAULT_BASEMAP: BasemapKey = 'grau';

const basemapLayerId = (key: BasemapKey): string => `basemap-${key}`;

/** Show one background, hide the others (hidden raster layers fetch nothing). */
export function setBasemap(
  map: { setLayoutProperty(layer: string, prop: string, value: unknown): void },
  key: BasemapKey,
): void {
  for (const k of Object.keys(BASEMAPS) as BasemapKey[]) {
    map.setLayoutProperty(basemapLayerId(k), 'visibility', k === key ? 'visible' : 'none');
  }
}

/** A 1x1 transparent PNG: the iso fill's placeholder before the first field. */
export const EMPTY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

/** Base style: the backgrounds, the network source, and the empty overlay sources. */
export function buildStyle(basemap: BasemapKey = DEFAULT_BASEMAP): StyleSpecification {
  const keys = Object.keys(BASEMAPS) as BasemapKey[];
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      ...Object.fromEntries(
        keys.map((k) => [
          basemapLayerId(k),
          { type: 'raster', tiles: [...BASEMAPS[k].tiles], tileSize: 256, maxzoom: BASEMAPS[k].maxzoom, attribution: BASEMAPS[k].attribution },
        ]),
      ),
      [EFFORT_SOURCE]: {
        type: 'vector',
        url: `pmtiles://${PMTILES_URL}`,
        // edge_id becomes the feature id so setFeatureState can target it.
        promoteId: { [TILE_LAYER]: 'edge_id' },
        // The network is derived from OpenStreetMap (ODbL): attribution required.
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>-Mitwirkende',
      },
      [ISO_FILL_SOURCE]: {
        type: 'image',
        url: EMPTY_PNG,
        coordinates: [[5.9, 47.9], [10.6, 47.9], [10.6, 45.7], [5.9, 45.7]],
      },
      [ISO_LINE_SOURCE]: { type: 'geojson', data: EMPTY_FC },
      [ROUTE_SOURCE]: { type: 'geojson', data: EMPTY_FC },
      [HOVER_SOURCE]: { type: 'geojson', data: EMPTY_FC },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#eef1f4' } },
      ...keys.map((k) => ({
        id: basemapLayerId(k),
        type: 'raster' as const,
        source: basemapLayerId(k),
        layout: { visibility: k === basemap ? ('visible' as const) : ('none' as const) },
      })),
      {
        id: ISO_FILL_LAYER,
        type: 'raster',
        source: ISO_FILL_SOURCE,
        maxzoom: ISO_MAX_ZOOM + 0.5,
        paint: {
          'raster-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.42, ISO_MAX_ZOOM - 0.5, 0.32, ISO_MAX_ZOOM + 0.5, 0],
          'raster-resampling': 'linear',
          'raster-fade-duration': 0,
        },
      },
      {
        id: ISO_LINE_LAYER,
        type: 'line',
        source: ISO_LINE_SOURCE,
        maxzoom: ISO_MAX_ZOOM + 0.5,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['==', ['get', 'last'], true], 2.8, 1.6],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], ISO_MAX_ZOOM - 0.5, 0.95, ISO_MAX_ZOOM + 0.5, 0],
        },
      },
    ],
  };
}

/** Route on top of everything: a white casing and a dark core (outside the palette). */
export function routeLayers(): LineLayerSpecification[] {
  return [
    {
      id: ROUTE_CASING_LAYER,
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 5, 14, 9], 'line-opacity': 0.95 },
    },
    {
      id: ROUTE_LAYER,
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#11161d', 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 14, 4.5] },
    },
  ];
}
