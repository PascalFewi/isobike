/**
 * The MapLibre map. Imperative (MapLibre owns its canvas), wrapped so React drives
 * it via props. Not unit-tested -- WebGL needs a browser; verify with `npm run dev`.
 *
 * The effort field and the route are both applied as `feature-state` on the one
 * PMTiles source (keyed by `edge_id` via `promoteId`): the field sets
 * `{time, cumAscent}`, the route sets `{onRoute}`. Fitness restyles the paint
 * expression only -- no re-application of state, no Worker call.
 */

import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { useEffect, useRef } from 'react';

import 'maplibre-gl/dist/maplibre-gl.css';

import type { EffortField } from '../lib/effortResponse.ts';
import {
  ASCENT_LAYER,
  EFFORT_LAYER,
  EFFORT_SOURCE,
  ascentLayer,
  buildStyle,
  effortColorExpression,
  effortLayer,
  effortOpacityExpression,
  routeLayer,
} from '../lib/mapStyle.ts';
import { INITIAL_VIEW, TILE_LAYER } from '../config.ts';

interface Props {
  readonly field: EffortField | null;
  readonly fitnessFactor: number;
  /** Client-side display budget, in displayed seconds. */
  readonly budgetDisplayS: number;
  readonly routeEdgeIds: readonly number[] | null;
  readonly onPick: (lat: number, lon: number) => void;
}

export function MapView({
  field,
  fitnessFactor,
  budgetDisplayS,
  routeEdgeIds,
  onPick,
}: Props): JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const appliedFieldIds = useRef<number[]>([]);
  const appliedRouteIds = useRef<number[]>([]);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  // Init once.
  useEffect(() => {
    if (container.current === null || map.current !== null) return;

    const protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);

    const m = new maplibregl.Map({
      container: container.current,
      style: buildStyle(),
      center: [INITIAL_VIEW.lon, INITIAL_VIEW.lat],
      zoom: INITIAL_VIEW.zoom,
    });
    m.addControl(new maplibregl.NavigationControl(), 'top-left');

    m.on('load', () => {
      m.addLayer(effortLayer(fitnessFactor));
      m.addLayer(ascentLayer(1));
      m.addLayer(routeLayer());
      ready.current = true;
    });
    m.on('click', (e) => onPickRef.current(e.lngLat.lat, e.lngLat.lng));

    map.current = m;
    return () => {
      m.remove();
      maplibregl.removeProtocol('pmtiles');
      map.current = null;
      ready.current = false;
    };
    // Init effect runs once; later prop changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply a new effort field: clear old state, set {time, cumAscent} per edge.
  useEffect(() => {
    const m = map.current;
    if (m === null) return;
    const apply = (): void => {
      for (const id of appliedFieldIds.current) {
        m.removeFeatureState({ source: EFFORT_SOURCE, sourceLayer: TILE_LAYER, id });
      }
      appliedFieldIds.current = [];
      if (field === null) return;
      for (let i = 0; i < field.count; i++) {
        const id = field.edgeIds[i];
        m.setFeatureState(
          { source: EFFORT_SOURCE, sourceLayer: TILE_LAYER, id },
          { time: field.times[i], cumAscent: field.cumAscents[i] },
        );
        appliedFieldIds.current.push(id);
      }
      // Rescale the ascent overlay to the new field's max.
      if (m.getLayer(ASCENT_LAYER)) {
        m.setPaintProperty(ASCENT_LAYER, 'line-opacity', ascentLayer(field.maxCumAscent).paint!['line-opacity']!);
      }
    };
    if (ready.current) apply();
    else m.once('idle', apply);
  }, [field]);

  // Fitness + budget: restyle colour thresholds and the display cutoff only.
  useEffect(() => {
    const m = map.current;
    if (m === null || !m.getLayer(EFFORT_LAYER)) return;
    m.setPaintProperty(EFFORT_LAYER, 'line-color', effortColorExpression(fitnessFactor));
    m.setPaintProperty(
      EFFORT_LAYER,
      'line-opacity',
      effortOpacityExpression(budgetDisplayS, fitnessFactor),
    );
  }, [fitnessFactor, budgetDisplayS]);

  // Route highlight via feature-state.
  useEffect(() => {
    const m = map.current;
    if (m === null) return;
    const apply = (): void => {
      for (const id of appliedRouteIds.current) {
        m.removeFeatureState({ source: EFFORT_SOURCE, sourceLayer: TILE_LAYER, id }, 'onRoute');
      }
      appliedRouteIds.current = [];
      if (routeEdgeIds === null) return;
      for (const id of routeEdgeIds) {
        m.setFeatureState({ source: EFFORT_SOURCE, sourceLayer: TILE_LAYER, id }, { onRoute: true });
        appliedRouteIds.current.push(id);
      }
    };
    if (ready.current) apply();
    else m.once('idle', apply);
  }, [routeEdgeIds]);

  return <div ref={container} style={{ position: 'absolute', inset: 0 }} />;
}
