/**
 * Right panel: rider and map settings, top to bottom in the order a rider sets
 * them. Profil, slope and surface change the route (a Worker call); flat speed
 * and budget only rescale and restyle (client-side). The two groups are marked
 * so the boundary stays visible in the UI, not just in the code.
 */

import { legendBands } from '../lib/colorScale.ts';
import { FLAT_KMH_MAX, FLAT_KMH_MIN, PROFILE_ANCHORS } from '../lib/profile.ts';

export type SurfaceMode = 'all' | 'gravel-ok' | 'paved';

export interface ControlState {
  readonly profileT: number;
  readonly maxSlope: number | null;
  readonly surfaceMode: SurfaceMode;
  readonly flatKmh: number;
  readonly budgetHours: number;
}

interface Props {
  readonly state: ControlState;
  /** The rider's VAM at this speed and profile, for the hint under the slider. */
  readonly vamHmh: number;
  readonly onChange: (patch: Partial<ControlState>) => void;
}

function profileLabel(t: number): string {
  if (t <= 0.16) return PROFILE_ANCHORS[0].label;
  if (t >= 0.84) return PROFILE_ANCHORS[2].label;
  if (t > 0.42 && t < 0.58) return PROFILE_ANCHORS[1].label;
  return 'dazwischen';
}

export function Controls({ state, vamHmh, onChange }: Props): JSX.Element {
  const bands = legendBands(state.budgetHours);
  return (
    <aside className="panel controls" aria-label="Einstellungen">
      <label className="ctl net" htmlFor="ctl-profile">
        <span className="ctl-head">Profil <strong>{profileLabel(state.profileT)}</strong></span>
        <input
          id="ctl-profile" type="range" min={0} max={1} step={0.01} value={state.profileT}
          onChange={(e) => onChange({ profileT: Number(e.target.value) })}
        />
        <span className="ends"><span>Flachfahrer</span><span>Bergfahrer</span></span>
      </label>

      <label className="ctl net" htmlFor="ctl-slope">
        <span className="ctl-head">Max. Steigung <strong>{state.maxSlope === null ? 'aus' : `${state.maxSlope} %`}</strong></span>
        <input
          id="ctl-slope" type="range" min={0} max={20} step={1} value={state.maxSlope ?? 0}
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange({ maxSlope: v === 0 ? null : v });
          }}
        />
      </label>

      <label className="ctl net" htmlFor="ctl-surface">
        <span className="ctl-head">Untergrund</span>
        <select
          id="ctl-surface" value={state.surfaceMode}
          onChange={(e) => onChange({ surfaceMode: e.target.value as SurfaceMode })}
        >
          <option value="all">Alles (Strasse + Gravel)</option>
          <option value="gravel-ok">Kein grober Weg</option>
          <option value="paved">Nur asphaltiert</option>
        </select>
      </label>

      <label className="ctl client" htmlFor="ctl-speed">
        <span className="ctl-head">Geschwindigkeit im Flachen <strong>{state.flatKmh} km/h</strong></span>
        <input
          id="ctl-speed" type="range" min={FLAT_KMH_MIN} max={FLAT_KMH_MAX} step={1} value={state.flatKmh}
          onChange={(e) => onChange({ flatKmh: Number(e.target.value) })}
        />
        <span className="hint">bergauf ≈ {Math.round(vamHmh)} Hm/h</span>
      </label>

      <label className="ctl client" htmlFor="ctl-budget">
        <span className="ctl-head">Zeitbudget <strong>{state.budgetHours} h</strong></span>
        <input
          id="ctl-budget" type="range" min={0.5} max={16} step={0.5} value={state.budgetHours}
          onChange={(e) => onChange({ budgetHours: Number(e.target.value) })}
        />
      </label>

      <div className="legend" aria-label="Legende Fahrzeit">
        {bands.map((b) => (
          <div className="legend-band" key={b.color}>
            <i style={{ background: b.color }} />
            <span>{b.from}–{b.to}</span>
          </div>
        ))}
      </div>

      <p className="note">
        <span className="dot net" /> löst eine neue Berechnung aus · <span className="dot client" /> sofort, ohne Rechnen
      </p>
    </aside>
  );
}
