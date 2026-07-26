/**
 * App state and the click flow.
 *
 * First click sets the start and fetches the effort field; second click sets the
 * destination and fetches a route; a further click starts over. Profil / slope /
 * surface changes refetch from the Worker (they change routing); Fitness / budget
 * / flat-km never touch the network -- they restyle the map and relabel.
 */

import { useEffect, useMemo, useState } from 'react';

import { Controls, type ControlState, type SurfaceMode } from './components/Controls.tsx';
import { Legend } from './components/Legend.tsx';
import { MapView } from './components/MapView.tsx';
import { StatsPanel } from './components/StatsPanel.tsx';
import { DEFAULT_BUDGET_S } from './config.ts';
import * as api from './lib/api.ts';
import type { EffortField } from './lib/effortResponse.ts';
import { fitnessToFactor, profileToSpeeds } from './lib/profile.ts';

interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

function surfacesFor(mode: SurfaceMode): number[] | undefined {
  if (mode === 'all') return undefined;
  if (mode === 'gravel-ok') return [api.Surface.Paved, api.Surface.Gravel];
  return [api.Surface.Paved];
}

export function App(): JSX.Element {
  const [controls, setControls] = useState<ControlState>({
    profileT: 0.5,
    fitnessT: 0.5,
    maxSlope: null,
    surfaceMode: 'all',
    budgetHours: 4,
    flatKm: false,
  });
  const [start, setStart] = useState<LatLon | null>(null);
  const [destination, setDestination] = useState<LatLon | null>(null);
  const [field, setField] = useState<EffortField | null>(null);
  const [routeResult, setRouteResult] = useState<api.RouteResult | null>(null);
  const [status, setStatus] = useState<string>('Klicke auf die Karte für einen Startpunkt.');

  const speeds = useMemo(() => profileToSpeeds(controls.profileT), [controls.profileT]);
  const fitnessFactor = fitnessToFactor(controls.fitnessT);
  const filters = useMemo<api.FilterOptions>(
    () => ({
      ...(controls.maxSlope !== null ? { maxSlopePct: controls.maxSlope } : {}),
      ...(surfacesFor(controls.surfaceMode) !== undefined
        ? { surfaces: surfacesFor(controls.surfaceMode)! }
        : {}),
    }),
    [controls.maxSlope, controls.surfaceMode],
  );

  // Effort field: on start or a routing-control change.
  useEffect(() => {
    if (start === null) return;
    let cancelled = false;
    setStatus('Berechne Erreichbarkeit…');
    api
      .effortField(start, speeds, filters, DEFAULT_BUDGET_S)
      .then((f) => {
        if (cancelled) return;
        setField(f);
        setStatus('Zweiter Klick: Ziel für eine Route.');
      })
      .catch((e: unknown) => {
        if (!cancelled) setStatus(`Fehler: ${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [start, speeds, filters]);

  // Route: when both ends are set, or a routing control changes.
  useEffect(() => {
    if (start === null || destination === null) {
      setRouteResult(null);
      return;
    }
    let cancelled = false;
    api
      .route(start, destination, speeds, filters)
      .then((r) => {
        if (!cancelled) setRouteResult(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setStatus(`Route-Fehler: ${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [start, destination, speeds, filters]);

  const onPick = (lat: number, lon: number): void => {
    if (start === null || destination !== null) {
      setStart({ lat, lon });
      setDestination(null);
      setRouteResult(null);
    } else {
      setDestination({ lat, lon });
    }
  };

  const routeEdgeIds = routeResult?.found ? (routeResult.edge_ids ?? []) : null;

  return (
    <div className="app">
      <MapView
        field={field}
        fitnessFactor={fitnessFactor}
        budgetDisplayS={controls.budgetHours * 3600}
        routeEdgeIds={routeEdgeIds}
        onPick={onPick}
      />
      <Controls state={controls} onChange={(patch) => setControls((c) => ({ ...c, ...patch }))} />
      {field !== null && (
        <Legend flatKm={controls.flatKm} vFlatMps={speeds.vFlatMps} fitnessFactor={fitnessFactor} />
      )}
      {routeResult !== null && (
        <StatsPanel
          route={routeResult}
          fitnessFactor={fitnessFactor}
          onClear={() => {
            setDestination(null);
            setRouteResult(null);
          }}
        />
      )}
      <div className="status">{status}</div>
    </div>
  );
}
