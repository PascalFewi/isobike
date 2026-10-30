/**
 * The MapLibre map. Imperative (MapLibre owns its canvas), wrapped so React drives
 * it via props. Not unit-tested -- WebGL needs a browser; verify with `npm run dev`.
 *
 * The basemap is a vector style loaded from a URL (config.ts); our sources and
 * layers are added once it has loaded -- see mapStyle.ts for what goes where.
 *
 * The overlays:
 *
 * - **Road types** (cycle path, quiet road, main road, gravel, path) from our
 *   network tiles, a fixed style; can be switched off in the map menu.
 *
 * - **Isolines + area**, one pair per detail level (1 km zoomed out, 250 m in),
 *   from the field's grids, recomputed client-side whenever the field, the leg
 *   offset, the speed or the budget changes.
 * - **Route** as its own GeoJSON line from the Worker's geometry, plus draggable
 *   waypoint markers and the elevation-chart hover point.
 * - **Cycling POIs** (water, shops, repair, ...) as icons from their own PMTiles;
 *   a click on one opens its popup instead of adding a waypoint.
 */

import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';

import 'maplibre-gl/dist/maplibre-gl.css';

import type { EffortField } from '../lib/effortResponse.ts';
import type { Coord } from '../lib/gpx.ts';
import { ISO_LEVELS, fillImage, gridCorners, isolines, smoothField } from '../lib/isolines.ts';
import { POI_INFO, POI_KINDS, POI_PIXEL_RATIO, POI_SUB_LABELS, poiImage, poiImageId, type PoiKind } from '../lib/pois.ts';
import {
  ELEVATION_ATTRIBUTION,
  EMPTY_PNG,
  HOVER_SOURCE,
  POI_LAYER,
  ROAD_LAYER_IDS,
  ROUTE_SOURCE,
  firstLabelLayer,
  isoFillSource,
  isoLineSource,
  overlaySources,
  topLayers,
  underLabelLayers,
} from '../lib/mapStyle.ts';
import { BASEMAP_STYLE_URL, INITIAL_VIEW } from '../config.ts';

export interface MapWaypoint {
  readonly lat: number;
  readonly lon: number;
  readonly letter: string;
  readonly label: string;
}

/** What the waypoint menu (a click on a marker) offers. */
export type WaypointAction = 'move' | 'delete' | 'again';

interface Props {
  readonly field: EffortField | null;
  /** Worker seconds already spent on the legs before the field's start point. */
  readonly offsetS: number;
  /** Rider speed / profile speed: displayed time = Worker time / factor. */
  readonly factor: number;
  readonly budgetHours: number;
  readonly showRoadTypes: boolean;
  readonly showPois: boolean;
  readonly waypoints: readonly MapWaypoint[];
  readonly route: readonly Coord[] | null;
  readonly hover: Coord | null;
  readonly onPick: (lat: number, lon: number) => void;
  readonly onMoveWaypoint: (index: number, lat: number, lon: number) => void;
  readonly onWaypointAction: (index: number, action: WaypointAction) => void;
  /** A waypoint waits for a map click to move there: crosshair cursor. */
  readonly picking: boolean;
}

type GeoJsonSource = maplibregl.GeoJSONSource;

export function MapView({
  field,
  offsetS,
  factor,
  budgetHours,
  showRoadTypes,
  showPois,
  waypoints,
  route,
  hover,
  onPick,
  onMoveWaypoint,
  onWaypointAction,
  picking,
}: Props): JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  // Map style loaded: effects rerun once sources and layers exist.
  const [ready, setReady] = useState(false);
  const markers = useRef<maplibregl.Marker[]>([]);
  const handlers = useRef({ onPick, onMoveWaypoint, onWaypointAction });
  handlers.current = { onPick, onMoveWaypoint, onWaypointAction };
  const waypointPopup = useRef<maplibregl.Popup | null>(null);

  // Slider drags: the isoline work follows these deferred copies, so
  // React skips the intermediate values instead of computing every one of them.
  const lazyFactor = useDeferredValue(factor);
  const lazyBudget = useDeferredValue(budgetHours);

  // Init once.
  useEffect(() => {
    if (container.current === null || map.current !== null) return;

    const protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);

    const m = new maplibregl.Map({
      container: container.current,
      style: BASEMAP_STYLE_URL,
      center: [INITIAL_VIEW.lon, INITIAL_VIEW.lat],
      zoom: INITIAL_VIEW.zoom,
      // Our own control below: always open, never folded behind an "i".
      attributionControl: false,
    });
    m.addControl(new maplibregl.NavigationControl(), 'top-right');
    // Added before the scale so it sits at the very bottom of the corner.
    m.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: ELEVATION_ATTRIBUTION }), 'bottom-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    m.on('load', () => {
      for (const [id, source] of Object.entries(overlaySources())) m.addSource(id, source);
      for (const kind of POI_KINDS) m.addImage(poiImageId(kind), poiImage(kind), { pixelRatio: POI_PIXEL_RATIO });
      // Reach and road types under the basemap's labels, so place names stay readable.
      const labels = firstLabelLayer(m.getStyle().layers);
      for (const layer of underLabelLayers()) m.addLayer(layer, labels);
      for (const layer of topLayers()) m.addLayer(layer);
      setReady(true);
    });
    m.on('click', (e) => {
      const poi = m.getLayer(POI_LAYER) ? m.queryRenderedFeatures(e.point, { layers: [POI_LAYER] })[0] : undefined;
      if (poi !== undefined && poi.geometry.type === 'Point') {
        const [lon, lat] = poi.geometry.coordinates;
        new maplibregl.Popup({ offset: 12, maxWidth: '240px' })
          .setLngLat([lon, lat])
          .setDOMContent(poiPopup(poi.properties))
          .addTo(m);
        return;
      }
      handlers.current.onPick(e.lngLat.lat, e.lngLat.lng);
    });
    m.on('mouseenter', POI_LAYER, () => {
      m.getCanvas().style.cursor = 'pointer';
    });
    m.on('mouseleave', POI_LAYER, () => {
      m.getCanvas().style.cursor = '';
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

  // The smoothed grids depend on offset and speed only: a budget change reuses them.
  const grids = field?.grids ?? null;
  const smooth = useMemo(
    () => grids?.map((g, i) => smoothField(g, offsetS / 60, lazyFactor, ISO_LEVELS[i]?.gapKm)) ?? null,
    [grids, offsetS, lazyFactor],
  );

  // Isolines + area per level: client-side from the smoothed grids, for this budget.
  useEffect(() => {
    const m = map.current;
    if (m === null || !ready) return;
    ISO_LEVELS.forEach((_, i) => {
      const lines = m.getSource(isoLineSource(i)) as GeoJsonSource | undefined;
      const fill = m.getSource(isoFillSource(i)) as maplibregl.ImageSource | undefined;
      if (lines === undefined || fill === undefined) return;
      const grid = grids?.[i];
      const field = smooth?.[i];
      if (grid === undefined || field === undefined) {
        lines.setData({ type: 'FeatureCollection', features: [] });
        fill.updateImage({ url: EMPTY_PNG });
        return;
      }
      lines.setData(isolines(grid, field, lazyBudget) as unknown as GeoJSON.FeatureCollection);
      const canvas = document.createElement('canvas');
      canvas.width = grid.nx;
      canvas.height = grid.ny;
      canvas.getContext('2d')!.putImageData(fillImage(field, grid.nx, grid.ny, lazyBudget), 0, 0);
      fill.updateImage({ url: canvas.toDataURL('image/png'), coordinates: gridCorners(grid) });
    });
  }, [grids, smooth, lazyBudget, ready]);

  // Road types on / off.
  useEffect(() => {
    const m = map.current;
    if (m === null || !ready) return;
    for (const id of ROAD_LAYER_IDS) m.setLayoutProperty(id, 'visibility', showRoadTypes ? 'visible' : 'none');
  }, [showRoadTypes, ready]);

  // POI overlay on / off.
  useEffect(() => {
    const m = map.current;
    if (m === null || !ready) return;
    m.setLayoutProperty(POI_LAYER, 'visibility', showPois ? 'visible' : 'none');
  }, [showPois, ready]);

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

  // Waypoint markers: rebuilt on change; drag to move, click for the menu.
  useEffect(() => {
    const m = map.current;
    if (m === null) return;
    for (const mk of markers.current) mk.remove();
    waypointPopup.current?.remove();
    markers.current = waypoints.map((w, i) => {
      const el = document.createElement('div');
      el.className = `wp-marker${i === 0 ? ' start' : ''}`;
      el.textContent = w.letter;
      const mk = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([w.lon, w.lat]).addTo(m);
      // A drag ends in a click on the same element: that one is not a menu click.
      let dragged = false;
      mk.on('dragstart', () => {
        dragged = true;
      });
      mk.on('dragend', () => {
        const p = mk.getLngLat();
        handlers.current.onMoveWaypoint(i, p.lat, p.lng);
      });
      el.addEventListener('click', (e) => {
        // A click on a marker must not also reach the map and add a waypoint there.
        e.stopPropagation();
        if (dragged) {
          dragged = false;
          return;
        }
        waypointPopup.current?.remove();
        const popup = new maplibregl.Popup({ offset: 16, maxWidth: '220px', closeButton: false })
          .setLngLat([w.lon, w.lat])
          .setDOMContent(
            waypointMenu(w, (action) => {
              popup.remove();
              handlers.current.onWaypointAction(i, action);
            }),
          )
          .addTo(m);
        waypointPopup.current = popup;
      });
      return mk;
    });
  }, [waypoints]);

  // Moving a waypoint by click: crosshair until the click lands.
  useEffect(() => {
    const m = map.current;
    if (m === null) return;
    m.getCanvas().style.cursor = picking ? 'crosshair' : '';
  }, [picking]);

  return <div ref={container} className="map" />;
}

/** The waypoint menu: its letter and place, then move / delete / add again. */
function waypointMenu(w: MapWaypoint, act: (action: WaypointAction) => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'wp-menu';
  const head = document.createElement('div');
  head.className = 'wp-menu-head';
  head.textContent = `${w.letter} · ${w.label}`;
  el.append(head);
  const items: Array<[WaypointAction, string]> = [
    ['move', 'Verschieben'],
    ['again', 'Nochmals hinzufügen'],
    ['delete', 'Löschen'],
  ];
  for (const [action, text] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = action === 'delete' ? 'danger' : '';
    b.textContent = text;
    b.addEventListener('click', () => act(action));
    el.append(b);
  }
  return el;
}

/**
 * Popup body for a POI: kind (or which lodging / shop), name, opening hours, and
 * a lodging's website. OSM text goes in as text, never HTML; a link only for
 * http(s) addresses.
 */
function poiPopup(props: Record<string, unknown>): HTMLElement {
  const el = document.createElement('div');
  el.className = 'poi-popup';
  const kind = props.kind as PoiKind;
  const line = (cls: string, text: string): void => {
    const p = document.createElement('div');
    p.className = cls;
    p.textContent = text;
    el.append(p);
  };
  const sub = typeof props.sub === 'string' ? POI_SUB_LABELS[props.sub] : undefined;
  line('poi-kind', sub ?? POI_INFO[kind]?.label ?? String(props.kind));
  if (typeof props.name === 'string') line('poi-name', props.name);
  if (typeof props.opening_hours === 'string') line('poi-hours', props.opening_hours);
  if (typeof props.website === 'string' && /^https?:\/\//i.test(props.website)) {
    const a = document.createElement('a');
    a.className = 'poi-link';
    a.href = props.website;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Website';
    el.append(a);
  }
  return el;
}
