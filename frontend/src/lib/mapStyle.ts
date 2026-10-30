/**
 * Our map layers on top of a vector basemap.
 *
 * The basemap is a ready-made MapLibre style ({@link BASEMAP_STYLE_URL}:
 * OpenFreeMap's light-grey Positron for now, a self-hosted Protomaps file later)
 * -- one fast vector map for all of Europe instead of country raster maps. Our
 * layers go in two places in it:
 *
 *   below its labels   reach area, road types, isolines -- so place names stay
 *                      readable on top of the colours
 *   on top             the route, the POIs, the elevation hover point
 *
 * Reach is drawn from the Worker's min-time grids (see isolines.ts): isolines
 * at the band edges over a soft area fill, one pair of layers per detail level.
 *
 * Road types come from our own network tiles (`network.pmtiles`, build/export.py:
 * `highway` and `surface` per road) with a fixed style: is it a cycle path, a
 * quiet paved road, a main road with traffic, gravel, or an MTB path. A fixed
 * style is drawn straight from the tile data, so it costs nothing per request.
 */

import type {
  ExpressionSpecification,
  FilterSpecification,
  LayerSpecification,
  LineLayerSpecification,
  RasterLayerSpecification,
  SourceSpecification,
  SymbolLayerSpecification,
} from 'maplibre-gl';

import { ISO_LEVELS } from './isolines.ts';
import { POI_IMAGE_PREFIX, POI_INFO, POI_KINDS } from './pois.ts';
import { NETWORK_TILE_LAYER, NETWORK_URL, POIS_URL, POI_TILE_LAYER } from '../config.ts';

export const NETWORK_SOURCE = 'network';
export const ROUTE_SOURCE = 'route';
export const HOVER_SOURCE = 'hover';
export const POI_SOURCE = 'pois';

export const ROUTE_CASING_LAYER = 'route-casing';
export const ROUTE_LAYER = 'route-line';
export const HOVER_LAYER = 'hover-point';
export const POI_LAYER = 'pois';

/** Source (and layer) ids of an isoline level's area fill and lines. */
export const isoFillSource = (level: number): string => `iso-fill-${level}`;
export const isoLineSource = (level: number): string => `iso-lines-${level}`;

/**
 * Credits shown on the map, bottom right, always open (OSM's attribution
 * guidelines want them visible on the map). The basemap style credits itself and
 * OpenStreetMap -- the source of our network and POI tiles too, so those carry
 * no second OSM credit. What the basemap cannot know: the elevation behind every
 * slope and profile, swissALTI3D in Switzerland and Copernicus GLO-30 along the
 * borders (build/dem.py).
 */
export const ELEVATION_ATTRIBUTION =
  'Höhen © <a href="https://www.swisstopo.admin.ch" target="_blank" rel="noreferrer">swisstopo</a>, ' +
  '<a href="https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model" target="_blank" rel="noreferrer">Copernicus DEM</a>';

/** A 1x1 transparent PNG: an iso fill's placeholder while there is no field. */
export const EMPTY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

// --------------------------------------------------------------------------- //
// Road types
// --------------------------------------------------------------------------- //

export const ROAD_KINDS = ['cycleway', 'road', 'main', 'gravel', 'path'] as const;
export type RoadKind = (typeof ROAD_KINDS)[number];

interface RoadKindInfo {
  readonly label: string;
  readonly color: string;
  /** Line width at zoom 14, px; scaled with zoom. */
  readonly width: number;
  readonly dash: 'solid' | 'dashed' | 'dotted';
}

/**
 * Zoom the road types appear at, all together, fading in over half a level. The
 * network tiles hold every road only from here (their last zoom, build -zg);
 * below it tippecanoe has thinned them to a fraction, which drew as fragments.
 */
export const ROAD_MINZOOM = 11;

/** What a rider wants to know of a road: can a road bike go here, and is there traffic? */
export const ROAD_INFO: Readonly<Record<RoadKind, RoadKindInfo>> = {
  cycleway: { label: 'Veloweg', color: '#2e7d32', width: 2.6, dash: 'solid' },
  road: { label: 'Nebenstrasse, asphaltiert', color: '#546e7a', width: 1.8, dash: 'solid' },
  main: { label: 'Hauptstrasse (Verkehr)', color: '#c62828', width: 3.2, dash: 'solid' },
  gravel: { label: 'Schotter / Feldweg', color: '#8d6e63', width: 2.2, dash: 'dashed' },
  path: { label: 'Naturweg / Pfad (MTB)', color: '#5d4037', width: 1.8, dash: 'dotted' },
};

const MAIN_ROADS = ['primary', 'primary_link', 'secondary', 'secondary_link'];
const TRAILS = ['path', 'bridleway', 'footway'];

/**
 * A network feature's road kind from its `highway` and `surface`. The surface
 * decides first -- a gravel main road is gravel to a road bike -- then the class;
 * a track or path without a surface tag counts as what it usually is.
 */
export const ROAD_KIND: ExpressionSpecification = [
  'case',
  ['==', ['get', 'surface'], 'unpaved'], 'path',
  ['==', ['get', 'surface'], 'gravel'], 'gravel',
  ['==', ['get', 'highway'], 'cycleway'], 'cycleway',
  ['in', ['get', 'highway'], ['literal', MAIN_ROADS]], 'main',
  ['all', ['==', ['get', 'surface'], 'unknown'], ['==', ['get', 'highway'], 'track']], 'gravel',
  ['all', ['==', ['get', 'surface'], 'unknown'], ['in', ['get', 'highway'], ['literal', TRAILS]]], 'path',
  'road',
];

function byRoadKind(value: (k: RoadKind) => number | string): ExpressionSpecification {
  const m: unknown[] = ['match', ROAD_KIND];
  for (const k of ROAD_KINDS) m.push(k, value(k));
  m.push(value('road'));
  return m as ExpressionSpecification;
}

const DASH: Record<RoadKindInfo['dash'], number[] | undefined> = {
  solid: undefined,
  dashed: [2.5, 1.5],
  dotted: [0.1, 1.8],
};

/** Road-type layers, one per dash style (MapLibre cannot vary the dash per feature). */
export function roadLayers(): LineLayerSpecification[] {
  return (['solid', 'dashed', 'dotted'] as const).map((dash) => {
    const kinds = ROAD_KINDS.filter((k) => ROAD_INFO[k].dash === dash);
    const filter = ['in', ROAD_KIND, ['literal', kinds]] as FilterSpecification;
    const width = (scale: number): ExpressionSpecification => byRoadKind((k) => ROAD_INFO[k].width * scale);
    return {
      id: `roads-${dash}`,
      type: 'line',
      source: NETWORK_SOURCE,
      'source-layer': NETWORK_TILE_LAYER,
      minzoom: ROAD_MINZOOM,
      filter,
      layout: {
        'line-cap': dash === 'dotted' ? 'round' : 'butt',
        'line-join': 'round',
        // Main roads over quiet ones where they meet.
        'line-sort-key': byRoadKind((k) => (k === 'main' ? 2 : k === 'cycleway' ? 1 : 0)),
      },
      paint: {
        'line-color': byRoadKind((k) => ROAD_INFO[k].color),
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], ROAD_MINZOOM, width(0.55), 14, width(1), 17, width(2.2)],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], ROAD_MINZOOM, 0, ROAD_MINZOOM + 0.5, 0.9],
        ...(DASH[dash] !== undefined ? { 'line-dasharray': DASH[dash] } : {}),
      },
    } satisfies LineLayerSpecification;
  });
}

export const ROAD_LAYER_IDS = roadLayers().map((l) => l.id);

// --------------------------------------------------------------------------- //
// Sources and layers
// --------------------------------------------------------------------------- //

/** Our sources, added to the basemap style once it has loaded. */
export function overlaySources(): Record<string, SourceSpecification> {
  return {
    [NETWORK_SOURCE]: { type: 'vector', url: `pmtiles://${NETWORK_URL}` },
    [POI_SOURCE]: { type: 'vector', url: `pmtiles://${POIS_URL}` },
    ...Object.fromEntries(
      ISO_LEVELS.flatMap((_, i) => [
        [isoFillSource(i), { type: 'image', url: EMPTY_PNG, coordinates: [[5.9, 47.9], [10.6, 47.9], [10.6, 45.7], [5.9, 45.7]] }],
        [isoLineSource(i), { type: 'geojson', data: EMPTY_FC }],
      ]),
    ),
    [ROUTE_SOURCE]: { type: 'geojson', data: EMPTY_FC },
    [HOVER_SOURCE]: { type: 'geojson', data: EMPTY_FC },
  };
}

/** Layers that go below the basemap's labels: reach area, road types, isolines. */
export function underLabelLayers(): LayerSpecification[] {
  const levels = ISO_LEVELS.map((level, i) => ({ ...level, i }));
  return [
    ...levels.map(({ i, minzoom, maxzoom }): RasterLayerSpecification => ({
      id: isoFillSource(i),
      type: 'raster',
      source: isoFillSource(i),
      minzoom,
      maxzoom,
      paint: {
        // Lighter close in, where the roads and the background matter more.
        'raster-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.42, 12, 0.28],
        'raster-resampling': 'linear',
        'raster-fade-duration': 0,
      },
    })),
    ...roadLayers(),
    ...levels.map(({ i, minzoom, maxzoom }): LineLayerSpecification => ({
      id: isoLineSource(i),
      type: 'line',
      source: isoLineSource(i),
      minzoom,
      maxzoom,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['case', ['==', ['get', 'last'], true], 2.8, 1.6],
        'line-opacity': 0.95,
      },
    })),
  ];
}

/** Layers on top of everything: route, POIs, hover point. */
export function topLayers(): LayerSpecification[] {
  return [
    ...routeLayers(),
    poiLayer(),
    {
      id: HOVER_LAYER,
      type: 'circle',
      source: HOVER_SOURCE,
      paint: { 'circle-radius': 6, 'circle-color': '#11161d', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 },
    },
  ];
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

/** `match` over the POI kind: one value per kind, in {@link POI_KINDS} order. */
function byKind(value: (kind: (typeof POI_KINDS)[number], i: number) => number | string): ExpressionSpecification {
  const m: unknown[] = ['match', ['get', 'kind']];
  POI_KINDS.forEach((k, i) => m.push(k, value(k, i)));
  m.push(value(POI_KINDS[0], 0));
  return m as ExpressionSpecification;
}

/**
 * Cycling POIs as icons (images from pois.ts, added by MapView). Each kind from
 * its own zoom; where icons collide, the earlier kind in {@link POI_KINDS} wins,
 * so water and repair outrank the many parking spots.
 */
export function poiLayer(): SymbolLayerSpecification {
  return {
    id: POI_LAYER,
    type: 'symbol',
    source: POI_SOURCE,
    'source-layer': POI_TILE_LAYER,
    minzoom: Math.min(...POI_KINDS.map((k) => POI_INFO[k].minzoom)),
    filter: ['>=', ['zoom'], byKind((k) => POI_INFO[k].minzoom)],
    layout: {
      'icon-image': ['concat', POI_IMAGE_PREFIX, ['get', 'kind']],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.75, 16, 1],
      'icon-padding': 1,
      'symbol-sort-key': byKind((_, i) => i),
    },
  };
}

/** The first label layer of a basemap style: our under-label layers go before it. */
export function firstLabelLayer(layers: readonly { id: string; type: string }[]): string | undefined {
  return layers.find((l) => l.type === 'symbol')?.id;
}
