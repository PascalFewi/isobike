/**
 * Route stats after the second click. Time is shown at the current Fitness
 * (client-side rescale); distance/ascent are physical and unaffected.
 */

import { applyFitness } from '../lib/profile.ts';
import type { RouteResult } from '../lib/api.ts';

interface Props {
  readonly route: RouteResult;
  readonly fitnessFactor: number;
  readonly onClear: () => void;
}

function hm(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function StatsPanel({ route, fitnessFactor, onClear }: Props): JSX.Element {
  return (
    <div className="stats">
      <button className="close" onClick={onClear} aria-label="Route schliessen">×</button>
      {route.found ? (
        <>
          <div className="stat"><span>Zeit</span><strong>{hm(applyFitness(route.cost_s ?? 0, fitnessFactor))}</strong></div>
          <div className="stat"><span>Distanz</span><strong>{((route.dist_m ?? 0) / 1000).toFixed(1)} km</strong></div>
          <div className="stat"><span>Aufstieg</span><strong>{Math.round(route.ascent_m ?? 0)} Hm</strong></div>
          <div className="stat"><span>Abstieg</span><strong>{Math.round(route.descent_m ?? 0)} Hm</strong></div>
          <div className="stat"><span>Max. Steigung</span><strong>{(route.max_slope_pct ?? 0).toFixed(1)} %</strong></div>
        </>
      ) : (
        <div className="stat unreachable">Keine Route unter diesen Einstellungen.</div>
      )}
    </div>
  );
}
