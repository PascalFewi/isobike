/**
 * App state and the planning flow.
 *
 * 1. The first point (click or search) fetches the effort field from there: the
 *    map shows where the rider gets within the budget.
 * 2. Every further point appends a leg (route from the previous point) and the
 *    field is recomputed *from the last point*, with the legs' time already on
 *    the clock: the Worker returns times from the new start, and the client adds
 *    the legs' total (`offsetS`). So the colour at the last point does not jump,
 *    and the remaining reach is what is left of the budget after the legs.
 * 3. Legs are cached by their endpoints and routing settings, so adding a point
 *    computes one new leg, not the whole route again.
 *
 * Profil / slope / surface change routing and refetch. Flat speed and budget are
 * client-side: displayed time = Worker time / speed factor. The field is fetched
 * with some headroom and only refetched when the needed reach grows past it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Controls, type ControlState, type SurfaceMode } from './components/Controls.tsx';
import { ElevationProfile } from './components/ElevationProfile.tsx';
import { MapView, type MapWaypoint } from './components/MapView.tsx';
import { Planner, type LegView } from './components/Planner.tsx';
import * as api from './lib/api.ts';
import type { EffortField } from './lib/effortResponse.ts';
import { coordLabel, municipalityAt, type Place } from './lib/geocode.ts';
import { buildGpx, downloadText, type Coord } from './lib/gpx.ts';
import { BASEMAPS, DEFAULT_BASEMAP, type BasemapKey } from './lib/mapStyle.ts';
import { FLAT_KMH_DEFAULT, displayTime, profileToSpeeds, riderVamHmh, speedFactor } from './lib/profile.ts';

interface Waypoint {
  readonly key: number;
  readonly lat: number;
  readonly lon: number;
  readonly label: string;
}

/** Extra reach fetched beyond the current need, so small slider moves stay local. */
const FIELD_HEADROOM = 1.25;
/** Wait this long after the last change before fetching a field (slider drags). */
const FIELD_DEBOUNCE_MS = 200;

function surfacesFor(mode: SurfaceMode): number[] | undefined {
  if (mode === 'all') return undefined;
  if (mode === 'gravel-ok') return [api.Surface.Paved, api.Surface.Gravel];
  return [api.Surface.Paved];
}

function letter(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
}

let nextKey = 1;

/** The background choice is a per-browser convenience; storage may be unavailable. */
const BASEMAP_STORAGE_KEY = 'isobike.basemap';
function storedBasemap(): BasemapKey {
  try {
    const v = localStorage.getItem(BASEMAP_STORAGE_KEY);
    return v !== null && v in BASEMAPS ? (v as BasemapKey) : DEFAULT_BASEMAP;
  } catch {
    return DEFAULT_BASEMAP;
  }
}

export function App(): JSX.Element {
  const [controls, setControls] = useState<ControlState>(() => ({
    profileT: 0.5,
    maxSlope: null,
    surfaceMode: 'all',
    flatKmh: FLAT_KMH_DEFAULT,
    budgetHours: 4,
    basemap: storedBasemap(),
  }));
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  /** The field on screen, what it was computed for, and the leg offset it carries. */
  const [field, setField] = useState<{ data: EffortField; key: string; limitS: number; offsetS: number } | null>(null);
  const [legVersion, setLegVersion] = useState(0);
  const legCache = useRef(new Map<string, api.RouteResult>());
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(BASEMAP_STORAGE_KEY, controls.basemap);
    } catch {
      // Private mode or blocked storage: the choice just is not remembered.
    }
  }, [controls.basemap]);

  const speeds = useMemo(() => profileToSpeeds(controls.profileT), [controls.profileT]);
  const factor = speedFactor(controls.flatKmh, speeds);
  const filters = useMemo<api.FilterOptions>(() => {
    const surfaces = surfacesFor(controls.surfaceMode);
    return {
      ...(controls.maxSlope !== null ? { maxSlopePct: controls.maxSlope } : {}),
      ...(surfaces !== undefined ? { surfaces } : {}),
    };
  }, [controls.maxSlope, controls.surfaceMode]);
  const routingKey = `${controls.profileT}|${controls.maxSlope}|${controls.surfaceMode}`;

  // ---- legs --------------------------------------------------------------- //
  const legKey = (a: Waypoint, b: Waypoint): string => `${a.lat},${a.lon}>${b.lat},${b.lon}|${routingKey}`;

  useEffect(() => {
    let cancelled = false;
    for (let i = 0; i + 1 < waypoints.length; i++) {
      const key = legKey(waypoints[i], waypoints[i + 1]);
      if (legCache.current.has(key)) continue;
      api
        .route(waypoints[i], waypoints[i + 1], speeds, filters)
        .then((r) => {
          legCache.current.set(key, r);
          if (!cancelled) setLegVersion((v) => v + 1);
        })
        .catch((e: unknown) => {
          if (!cancelled) setStatus(`Route-Fehler: ${String(e)}`);
        });
    }
    return () => {
      cancelled = true;
    };
    // legKey depends only on routingKey, listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waypoints, speeds, filters, routingKey]);

  const legs = useMemo(() => {
    const out: Array<api.RouteResult | null> = [];
    for (let i = 0; i + 1 < waypoints.length; i++) out.push(legCache.current.get(legKey(waypoints[i], waypoints[i + 1])) ?? null);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waypoints, routingKey, legVersion]);

  const legsReady = legs.every((l) => l !== null);
  const offsetS = legs.reduce((s, l) => s + (l?.found ? (l.cost_s ?? 0) : 0), 0);

  // ---- field from the last point ------------------------------------------ //
  const last = waypoints[waypoints.length - 1];
  const neededS = controls.budgetHours * 3600 * factor - offsetS; // Worker seconds still to go
  const fieldKey = last === undefined ? '' : `${last.lat},${last.lon}|${routingKey}|${offsetS}`;
  const fieldFresh = field !== null && field.key === fieldKey && field.limitS >= neededS;

  useEffect(() => {
    if (last === undefined) {
      setField(null);
      return;
    }
    if (!legsReady || fieldFresh) return;
    if (neededS <= 0) {
      setField(null);
      setStatus('Das Zeitbudget ist mit dieser Route aufgebraucht.');
      return;
    }
    let cancelled = false;
    const limitS = neededS * FIELD_HEADROOM;
    const offset = offsetS;
    const timer = setTimeout(() => {
      setStatus('Berechne Erreichbarkeit…');
      api
        .effortField(last, speeds, filters, limitS)
        .then((data) => {
          if (cancelled) return;
          setField({ data, key: fieldKey, limitS, offsetS: offset });
          setStatus(null);
        })
        .catch((e: unknown) => {
          if (!cancelled) setStatus(`Fehler: ${String(e)}`);
        });
    }, FIELD_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [last, legsReady, fieldFresh, fieldKey, neededS, offsetS, speeds, filters]);

  // ---- route polyline + elevation ----------------------------------------- //
  const { coords, stops } = useMemo(() => {
    const all: Coord[] = [];
    const stopIdx: number[] = [];
    for (const l of legs) {
      const g = l?.found ? l.geometry : undefined;
      if (g !== undefined && g.length > 0) all.push(...(all.length === 0 ? g : g.slice(1)));
      stopIdx.push(Math.max(0, all.length - 1));
    }
    return { coords: all, stops: stopIdx };
  }, [legs]);

  const legViews: Array<LegView | null> = legs.map((l) =>
    l === null
      ? null
      : {
          found: l.found,
          timeS: displayTime(l.cost_s ?? 0, factor),
          distM: l.dist_m ?? 0,
          ascentM: l.ascent_m ?? 0,
          descentM: l.descent_m ?? 0,
          maxSlopePct: l.max_slope_pct ?? 0,
        },
  );

  // ---- waypoint edits ----------------------------------------------------- //
  const nameLater = useCallback((key: number, lat: number, lon: number) => {
    void municipalityAt(lat, lon).then((name) => {
      if (name === null) return;
      setWaypoints((ws) => ws.map((w) => (w.key === key && w.label === coordLabel(lat, lon) ? { ...w, label: name } : w)));
    });
  }, []);

  const addAt = (lat: number, lon: number, label?: string): void => {
    const key = nextKey++;
    setWaypoints((ws) => [...ws, { key, lat, lon, label: label ?? coordLabel(lat, lon) }]);
    if (label === undefined) nameLater(key, lat, lon);
  };
  const setPlace = (i: number, p: Place): void =>
    setWaypoints((ws) => ws.map((w, k) => (k === i ? { ...w, lat: p.lat, lon: p.lon, label: p.label } : w)));
  const moveTo = (i: number, lat: number, lon: number): void => {
    setWaypoints((ws) => ws.map((w, k) => (k === i ? { ...w, lat, lon, label: coordLabel(lat, lon) } : w)));
    const w = waypoints[i];
    if (w !== undefined) nameLater(w.key, lat, lon);
  };
  const remove = (i: number): void => setWaypoints((ws) => ws.filter((_, k) => k !== i));
  const shift = (i: number, d: -1 | 1): void =>
    setWaypoints((ws) => {
      const j = i + d;
      if (j < 0 || j >= ws.length) return ws;
      const out = [...ws];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });

  const exportGpx = (): void => {
    const name = `${waypoints[0]?.label ?? 'Start'} – ${last?.label ?? 'Ziel'}`;
    const gpx = buildGpx(
      name,
      coords,
      waypoints.map((w, i) => ({ lat: w.lat, lon: w.lon, name: `${letter(i)} ${w.label}` })),
    );
    const slug = name.toLowerCase().replace(/[^a-z0-9äöü]+/g, '-').replace(/^-|-$/g, '');
    downloadText(`velorouter-${slug || 'route'}.gpx`, gpx);
  };

  const mapWaypoints: MapWaypoint[] = useMemo(
    () => waypoints.map((w, i) => ({ lat: w.lat, lon: w.lon, letter: letter(i) })),
    [waypoints],
  );
  const hover = hoverIdx !== null && hoverIdx < coords.length ? coords[hoverIdx] : null;
  const showProfile = waypoints.length >= 2 && coords.length > 1;

  return (
    <div className={`app${showProfile ? ' with-profile' : ''}`}>
      <MapView
        field={field?.data ?? null}
        offsetS={field?.offsetS ?? 0}
        factor={factor}
        budgetHours={controls.budgetHours}
        basemap={controls.basemap}
        waypoints={mapWaypoints}
        route={coords.length > 1 ? coords : null}
        hover={hover}
        onPick={(lat, lon) => addAt(lat, lon)}
        onMoveWaypoint={moveTo}
      />
      <Planner
        waypoints={waypoints.map((w, i) => ({ key: w.key, letter: letter(i), label: w.label }))}
        legs={legViews}
        canExport={coords.length > 1}
        onSetPlace={setPlace}
        onAddPlace={(p) => addAt(p.lat, p.lon, p.label)}
        onRemove={remove}
        onShift={shift}
        onReverse={() => setWaypoints((ws) => [...ws].reverse())}
        onClear={() => setWaypoints([])}
        onExport={exportGpx}
      />
      <Controls
        state={controls}
        vamHmh={riderVamHmh(controls.flatKmh, speeds)}
        onChange={(patch) => setControls((c) => ({ ...c, ...patch }))}
      />
      {showProfile && (
        <ElevationProfile coords={coords} stops={stops} letters={waypoints.map((_, i) => letter(i))} onHover={setHoverIdx} />
      )}
      {status !== null && <div className="status" role="status">{status}</div>}
    </div>
  );
}
