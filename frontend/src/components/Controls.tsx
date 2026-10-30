/**
 * The settings, as pieces placed where a rider looks for them:
 *
 * - {@link TripControls}: time budget (titled) and bike, at the top of the route planner.
 * - {@link Legend}: the time bands, in the map menu under the isochrone switch.
 * - {@link RiderSettings}: Profil, Form and max. slope, behind the bike button
 *   on the map (MapButtons.tsx).
 *
 * Profil, bike and slope change the route (a Worker call); Form and budget only
 * rescale and restyle (client-side).
 */

import { legendBands } from '../lib/colorScale.ts';
import { FLAT_KMH_MAX, FLAT_KMH_MIN, PROFILE_ANCHORS } from '../lib/profile.ts';

/** Which bike: decides which surfaces the routing may use. */
export type BikeType = 'road' | 'gravel' | 'mtb';

export const BIKES: ReadonlyArray<{ readonly key: BikeType; readonly label: string; readonly title: string }> = [
  { key: 'road', label: 'Rennvelo', title: 'Nur asphaltierte Wege' },
  { key: 'gravel', label: 'Gravel', title: 'Asphalt und Schotter, kein grober Naturweg' },
  { key: 'mtb', label: 'MTB', title: 'Alle Wege' },
];

export interface ControlState {
  readonly profileT: number;
  readonly maxSlope: number | null;
  readonly bike: BikeType;
  readonly flatKmh: number;
  readonly budgetHours: number;
  /** Map display, set in the map menu; kept here so all settings share one state. */
  readonly isochrones: boolean;
  readonly roadTypes: boolean;
  readonly pois: boolean;
}

type OnChange = (patch: Partial<ControlState>) => void;

export function profileLabel(t: number): string {
  if (t <= 0.16) return PROFILE_ANCHORS[0].label;
  if (t >= 0.84) return PROFILE_ANCHORS[2].label;
  if (t > 0.42 && t < 0.58) return PROFILE_ANCHORS[1].label;
  return 'dazwischen';
}

const FORM_LEVELS = ['gemütlich', 'Hobby', 'sportlich', 'ambitioniert', 'Profi'] as const;

/** The rider's form in words, from the flat speed the slider sets. */
export function formLabel(flatKmh: number): string {
  const t = (flatKmh - FLAT_KMH_MIN) / (FLAT_KMH_MAX - FLAT_KMH_MIN);
  return FORM_LEVELS[Math.min(FORM_LEVELS.length - 1, Math.max(0, Math.floor(t * FORM_LEVELS.length)))];
}

/** Budget (with its title) and bike (self-explaining buttons): the planner's first row. */
export function TripControls({ state, onChange }: { readonly state: ControlState; readonly onChange: OnChange }): JSX.Element {
  return (
    <div className="trip">
      <label className="ctl" htmlFor="ctl-budget">
        <span className="ctl-head">Zeitbudget <strong>{state.budgetHours} h</strong></span>
        <input
          id="ctl-budget" type="range" min={0.5} max={16} step={0.5} value={state.budgetHours}
          onChange={(e) => onChange({ budgetHours: Number(e.target.value) })}
        />
      </label>
      <div className="seg seg-fill" role="group" aria-label="Fahrrad">
        {BIKES.map((b) => (
          <button key={b.key} type="button" title={b.title} aria-pressed={state.bike === b.key} onClick={() => onChange({ bike: b.key })}>
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Profil, Form, max. slope: behind the bike button on the map. */
export function RiderSettings({
  state,
  vamHmh,
  onChange,
}: {
  readonly state: ControlState;
  /** The rider's VAM at this form and profile, for the hint under the Form slider. */
  readonly vamHmh: number;
  readonly onChange: OnChange;
}): JSX.Element {
  return (
    <>
      <label className="ctl" htmlFor="ctl-profile">
        <span className="ctl-head">Profil <strong>{profileLabel(state.profileT)}</strong></span>
        <input
          id="ctl-profile" type="range" min={0} max={1} step={0.01} value={state.profileT}
          onChange={(e) => onChange({ profileT: Number(e.target.value) })}
        />
        <span className="ends"><span>Flachfahrer</span><span>Bergfahrer</span></span>
      </label>

      <label className="ctl" htmlFor="ctl-form">
        <span className="ctl-head">Form <strong>{formLabel(state.flatKmh)}</strong></span>
        <input
          id="ctl-form" type="range" min={FLAT_KMH_MIN} max={FLAT_KMH_MAX} step={1} value={state.flatKmh}
          onChange={(e) => onChange({ flatKmh: Number(e.target.value) })}
        />
        <span className="hint">≈ {state.flatKmh} km/h im Flachen · {Math.round(vamHmh)} Hm/h bergauf</span>
      </label>

      <label className="ctl" htmlFor="ctl-slope">
        <span className="ctl-head">Max. Steigung <strong>{state.maxSlope === null ? 'aus' : `${state.maxSlope} %`}</strong></span>
        <input
          id="ctl-slope" type="range" min={0} max={20} step={1} value={state.maxSlope ?? 0}
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange({ maxSlope: v === 0 ? null : v });
          }}
        />
      </label>
    </>
  );
}

/** The ride-time colour bands: in the map menu, and above the phone sheet. */
export function Legend({ budgetHours }: { readonly budgetHours: number }): JSX.Element {
  return (
    <div className="legend" aria-label="Legende Fahrzeit">
      {legendBands(budgetHours).map((b) => (
        <div className="legend-band" key={b.color}>
          <i style={{ background: b.color }} />
          <span>{b.from}–{b.to}</span>
        </div>
      ))}
    </div>
  );
}
