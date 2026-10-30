import { createExpression, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { StyleSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';

import { ISO_LEVELS } from '../src/lib/isolines.ts';
import {
  ROAD_INFO,
  ROAD_KIND,
  ROAD_KINDS,
  ROAD_MINZOOM,
  firstLabelLayer,
  isoFillSource,
  isoLineSource,
  overlaySources,
  poiLayer,
  roadLayers,
  topLayers,
  underLabelLayers,
} from '../src/lib/mapStyle.ts';
import { POI_INFO, POI_KINDS } from '../src/lib/pois.ts';

/** Our layers in a stand-in basemap: a background and one label layer. */
function fullStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://example.test/{fontstack}/{range}.pbf',
    sources: { base: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }, ...overlaySources() },
    layers: [
      { id: 'bg', type: 'background' },
      ...underLabelLayers(),
      { id: 'labels', type: 'symbol', source: 'base', layout: { 'text-field': 'x' } },
      ...topLayers(),
    ],
  };
}

function kindOf(highway: string, surface: string): unknown {
  const e = createExpression(ROAD_KIND);
  if (e.result !== 'success') throw new Error(JSON.stringify(e.value));
  return e.value.evaluate({ zoom: 14 }, { type: 'LineString', properties: { highway, surface } } as never);
}

describe('map style', () => {
  it('is valid with every overlay layer in a basemap', () => {
    expect(validateStyleMin(fullStyle())).toEqual([]);
  });

  it('puts reach and road types under the labels, route and POIs on top', () => {
    const ids = fullStyle().layers.map((l) => l.id);
    const labels = ids.indexOf('labels');
    for (let i = 0; i < ISO_LEVELS.length; i++) {
      expect(ids.indexOf(isoFillSource(i))).toBeLessThan(labels);
      expect(ids.indexOf(isoLineSource(i))).toBeLessThan(labels);
    }
    for (const l of roadLayers()) expect(ids.indexOf(l.id)).toBeLessThan(labels);
    expect(ids.indexOf('pois')).toBeGreaterThan(labels);
    expect(firstLabelLayer(fullStyle().layers)).toBe('labels');
  });

  it('shows exactly one isoline level at every zoom', () => {
    expect(ISO_LEVELS[0].minzoom).toBe(0);
    for (let i = 1; i < ISO_LEVELS.length; i++) expect(ISO_LEVELS[i].minzoom).toBe(ISO_LEVELS[i - 1].maxzoom);
    expect(ISO_LEVELS[ISO_LEVELS.length - 1].maxzoom).toBeGreaterThanOrEqual(22);
  });

  it('gives every POI kind a zoom in the layer filter', () => {
    const filter = JSON.stringify(poiLayer().filter);
    for (const k of POI_KINDS) expect(filter).toContain(`"${k}",${POI_INFO[k].minzoom}`);
    expect(poiLayer().minzoom).toBe(Math.min(...POI_KINDS.map((k) => POI_INFO[k].minzoom)));
  });
});

describe('road types', () => {
  it.each([
    ['cycleway', 'paved', 'cycleway'],
    ['cycleway', 'unknown', 'cycleway'],
    ['primary', 'paved', 'main'],
    ['secondary_link', 'unknown', 'main'],
    ['tertiary', 'paved', 'road'],
    ['residential', 'unknown', 'road'],
    ['track', 'paved', 'road'],
    ['track', 'unknown', 'gravel'],
    ['track', 'gravel', 'gravel'],
    ['primary', 'gravel', 'gravel'],
    ['path', 'unknown', 'path'],
    ['track', 'unpaved', 'path'],
    ['cycleway', 'unpaved', 'path'],
  ])('%s with %s surface is %s', (highway, surface, kind) => {
    expect(kindOf(highway, surface)).toBe(kind);
  });

  it('draws every kind in exactly one layer', () => {
    // filter = ['in', ROAD_KIND, ['literal', kinds]]
    const drawn = roadLayers().flatMap((l) => (l.filter as unknown as [string, unknown, [string, string[]]])[2][1]);
    expect(drawn.sort()).toEqual([...ROAD_KINDS].sort());
  });

  it('brings every road type in at the same zoom, where the tiles are complete', () => {
    for (const l of roadLayers()) expect(l.minzoom).toBe(ROAD_MINZOOM);
    expect(ROAD_INFO.main).not.toHaveProperty('minzoom');
  });
});
