/**
 * The MapLibre map. Imperative (MapLibre owns its canvas), wrapped so React drives
 * it via props. Not unit-tested -- WebGL needs a browser; verify with `npm run dev`.
 *
 * The overlays, see mapStyle.ts for which shows at which zoom:
 *
 * - **Isolines + area** from the field's 1 km grid, recomputed client-side
 *   whenever the field, the leg offset, the speed or the budget changes.
 * - **Road colouring** via `feature-state.time` on the PMTiles features. A 16 h
 *   field reaches ~1.8 M edges; stamping all of them would block the page for
 *   seconds, so only the features of the *loaded tiles* are stamped, again on
 *   every pan/zoom (`stampVisible`). Below {@link STAMP_MIN_ZOOM} nothing is
 *   stamped at all -- the isolines carry the display there.
 * - **Route** as its own GeoJSON line from the Worker's geometry, plus draggable
 *   waypoint markers and the elevation-chart hover point.
 */

import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { useEffect, useRef, useState } from 'react';

import 'maplibre-gl/dist/maplibre-gl.css';

import type { EffortField } from '../lib/effortResponse.ts';
import type { Coord } from '../lib/gpx.ts';
import { fillImage, gridCorners, isolines, smoothField } from '../lib/isolines.ts';
import {
  EFFORT_SOURCE,
  HOVER_LAYER,
  HOVER_SOURCE,
  ISO_FILL_SOURCE,
  ISO_LINE_SOURCE,
  ROUTE_SOURCE,
  STAMP_MIN_ZOOM,
  buildStyle,
  restyleRoads,
  setBasemap,
  type BasemapKey,
  roadLayers,
  routeLayers,
} from '../lib/mapStyle.ts';
import { INITIAL_VIEW, TILE_LAYER } from '../config.ts';

export interface MapWaypoint {
  readonly lat: number;
  readonly lon: number;
  readonly letter: string;
}

interface Props {
  readonly field: EffortField | null;
  /** Worker seconds already spent on the legs before the field's start point. */
  readonly offsetS: number;
  /** Rider speed / profile speed: displayed time = Worker time / factor. */
  readonly factor: number;
  readonly budgetHours: number;
  readonly basemap: BasemapKey;
  readonly waypoints: readonly MapWaypoint[];
  readonly route: readonly Coord[] | null;
  readonly hover: Coord | null;
  readonly onPick: (lat: number, lon: number) => void;
  readonly onMoveWaypoint: (index: number, lat: number, lon: number) => void;
}

type GeoJsonSource = maplibregl.GeoJSONSource;

export function MapView({
  field,
  offsetS,
  factor,
  budgetHours,
  basemap,
  waypoints,
  route,
  hover,
  onPick,
  onMoveWaypoint,
}: Props): JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  // Map style loaded: effects rerun once sources and layers exist.
  const [ready, setReady] = useState(false);
  const markers = useRef<maplibregl.Marker[]>([]);
  const handlers = useRef({ onPick, onMoveWaypoint });
  handlers.current = { onPick, onMoveWaypoint };

  // Dense per-edge time (Worker s incl. offset; NaN = not in field) + stamped flags.
  const stamp = useRef<{ time: Float32Array | null; done: Uint8Array | null }>({ time: null, done: null });
  const stampScheduled = useRef(false);

  // Init once.
  useEffect(() => {
    if (container.current === null || map.current !== null) return;

    const protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);

    const m = new maplibregl.Map({
      container: container.current,
      style: buildStyle(basemap),
      center: [INITIAL_VIEW.lon, INITIAL_VIEW.lat],
      zoom: INITIAL_VIEW.zoom,
    });
    m.addControl(new maplibregl.NavigationControl(), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    const scheduleStamp = (): void => {
      if (stampScheduled.current) return;
      stampScheduled.current = true;
      requestAnimationFrame(() => {
        stampScheduled.current = false;
        stampVisible(m, stamp.current);
      });
    };

    m.on('load', () => {
      for (const layer of roadLayers(4, 1)) m.addLayer(layer);
      for (const layer of routeLayers()) m.addLayer(layer);
      m.addLayer({
        id: HOVER_LAYER,
        type: 'circle',
        source: HOVER_SOURCE,
        paint: { 'circle-radius': 6, 'circle-color': '#11161d', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 },
      });
      setReady(true);
    });
    m.on('click', (e) => handlers.current.onPick(e.lngLat.lat, e.lngLat.lng));
    m.on('moveend', scheduleStamp);
    m.on('sourcedata', (e) => {
      if (e.sourceId === EFFORT_SOURCE && e.isSourceLoaded) scheduleStamp();
    });

    map.current = m;
    return () => {
      m.remove();
      maplibregl.removeProtocol('pmtiles');
      map.current = null;
    };
    // Init effect runs once; later prop changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New field or offset: rebuild the dense time table and restamp what is loaded.
  useEffect(() => {
    const m = map.current;
    if (m === null || !ready) return;
    m.removeFeatureState({ source: EFFORT_SOURCE, sourceLayer: TILE_LAYER });
    if (field === null) {
      stamp.current = { time: null, done: null };
      return;
    }
    let maxId = 0;
    for (let i = 0; i < field.count; i++) if (field.edgeIds[i] > maxId) maxId = field.edgeIds[i];
    const time = new Float32Array(maxId + 1).fill(Number.NaN);
    for (let i = 0; i < field.count; i++) time[field.edgeIds[i]] = field.times[i] + offsetS;
    stamp.current = { time, done: new Uint8Array(maxId + 1) };
    stampVisible(m, stamp.current);
  }, [field, offsetS, ready]);

  // Isolines + area: client-side from the grid, for this offset / speed / budget.
  useEffect(() => {
    const m = map.current;
    if (m === null || !ready) return;
    const lines = m.getSource(ISO_LINE_SOURCE) as GeoJsonSource | undefined;
    const fill = m.getSource(ISO_FILL_SOURCE) as maplibregl.ImageSource | undefined;
    if (lines === undefined || fill === undefined) return;
    const grid = field?.grid ?? null;
    if (grid === null) {
      lines.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    const smooth = smoothField(grid, offsetS / 60, factor);
    lines.setData(isolines(grid, smooth, budgetHours) as unknown as GeoJSON.FeatureCollection);
    const canvas = document.createElement('canvas');
    canvas.width = grid.nx;
    canvas.height = grid.ny;
    canvas.getContext('2d')!.putImageData(fillImage(smooth, grid.nx, grid.ny, budgetHours), 0, 0);
    fill.updateImage({ url: canvas.toDataURL('image/png'), coordinates: gridCorners(grid) });
  }, [field, offsetS, factor, budgetHours, ready]);

  // Speed + budget: restyle the road layers only.
  useEffect(() => {
    const m = map.current;
    if (m === null || !ready) return;
    restyleRoads(m, budgetHours, factor);
  }, [budgetHours, factor, ready]);

  // Background switch: visibility only, so the overlays stay untouched.
  useEffect(() => {
    const m = map.current;
    if (m === null || !ready) return;
    setBasemap(m, basemap);
  }, [basemap, ready]);

  // Route line.
  useEffect(() => {
    const m = map.current;
    if (m === null || !ready) return;
    const src = m.getSource(ROUTE_SOURCE) as GeoJsonSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features:
        route !== null && route.length > 1
          ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.map(([lon, lat]) => [lon, lat]) } }]
          : [],
    });
  }, [route, ready]);

  // Elevation-chart hover point.
  useEffect(() => {
    const m = map.current;
    if (m === null || !ready) return;
    const src = m.getSource(HOVER_SOURCE) as GeoJsonSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: hover === null ? [] : [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [hover[0], hover[1]] } }],
    });
  }, [hover, ready]);

  // Waypoint markers: rebuilt on change; drag to move.
  useEffect(() => {
    const m = map.current;
    if (m === null) return;
    for (const mk of markers.current) mk.remove();
    markers.current = waypoints.map((w, i) => {
      const el = document.createElement('div');
      el.className = `wp-marker${i === 0 ? ' start' : ''}`;
      el.textContent = w.letter;
      // A click on a marker must not also reach the map and add a waypoint there.
      el.addEventListener('click', (e) => e.stopPropagation());
      const mk = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([w.lon, w.lat]).addTo(m);
      mk.on('dragend', () => {
        const p = mk.getLngLat();
        handlers.current.onMoveWaypoint(i, p.lat, p.lng);
      });
      return mk;
    });
  }, [waypoints]);

  return <div ref={container} className="map" />;
}

/** Stamp `feature-state.time` on loaded features not stamped yet (see header). */
function stampVisible(m: maplibregl.Map, s: { time: Float32Array | null; done: Uint8Array | null }): void {
  const { time, done } = s;
  if (time === null || done === null || m.getZoom() < STAMP_MIN_ZOOM || !m.getSource(EFFORT_SOURCE)) return;
  for (const f of m.querySourceFeatures(EFFORT_SOURCE, { sourceLayer: TILE_LAYER })) {
    const id = f.id;
    if (typeof id !== 'number' || id >= time.length || done[id] === 1) continue;
    done[id] = 1;
    const t = time[id];
    if (Number.isNaN(t)) continue;
    m.setFeatureState({ source: EFFORT_SOURCE, sourceLayer: TILE_LAYER, id }, { time: t });
  }
}
