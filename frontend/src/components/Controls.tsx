/**
 * The control panel. Sliders that change routing (Profil, slope, surface) call
 * back to trigger a Worker refetch; sliders that are pure display (Fitness,
 * budget, flat-km) restyle client-side. The labels below say which is which so
 * the boundary stays visible in the UI, not just the code.
 */

import { PROFILE_ANCHORS } from '../lib/profile.ts';

export type SurfaceMode = 'all' | 'gravel-ok' | 'paved';

export interface ControlState {
  readonly profileT: number;
  readonly fitnessT: number;
  readonly maxSlope: number | null;
  readonly surfaceMode: SurfaceMode;
  readonly budgetHours: number;
  readonly flatKm: boolean;
}

interface Props {
  readonly state: ControlState;
  readonly onChange: (patch: Partial<ControlState>) => void;
}

function profileLabel(t: number): string {
  if (t <= 0.16) return PROFILE_ANCHORS[0].label;
  if (t >= 0.84) return PROFILE_ANCHORS[2].label;
  if (t > 0.42 && t < 0.58) return PROFILE_ANCHORS[1].label;
  return '…';
}

export function Controls({ state, onChange }: Props): JSX.Element {
  return (
    <div className="controls">
      <h1>VeloRouter</h1>

      <label className="net">
        Profil: <strong>{profileLabel(state.profileT)}</strong>
        <input
          type="range" min={0} max={1} step={0.01} value={state.profileT}
          onChange={(e) => onChange({ profileT: Number(e.target.value) })}
        />
        <span className="ends"><span>Flachfahrer</span><span>Bergfahrer</span></span>
      </label>

      <label className="net">
        Max. Steigung: <strong>{state.maxSlope === null ? 'aus' : `${state.maxSlope} %`}</strong>
        <input
          type="range" min={0} max={20} step={1} value={state.maxSlope ?? 0}
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange({ maxSlope: v === 0 ? null : v });
          }}
        />
      </label>

      <label className="net">
        Untergrund:
        <select
          value={state.surfaceMode}
          onChange={(e) => onChange({ surfaceMode: e.target.value as SurfaceMode })}
        >
          <option value="all">Alles (Road + Gravel)</option>
          <option value="gravel-ok">Kein grober Weg</option>
          <option value="paved">Nur asphaltiert</option>
        </select>
      </label>

      <hr />

      <label className="client">
        Fitness <span className="hint">(rein clientseitig)</span>
        <input
          type="range" min={0} max={1} step={0.01} value={state.fitnessT}
          onChange={(e) => onChange({ fitnessT: Number(e.target.value) })}
        />
        <span className="ends"><span>0.7×</span><span>1.3×</span></span>
      </label>

      <label className="client">
        Zeit-Budget: <strong>{state.budgetHours} h</strong> <span className="hint">(clientseitig)</span>
        <input
          type="range" min={0.5} max={8} step={0.5} value={state.budgetHours}
          onChange={(e) => onChange({ budgetHours: Number(e.target.value) })}
        />
      </label>

      <label className="client checkbox">
        <input
          type="checkbox" checked={state.flatKm}
          onChange={(e) => onChange({ flatKm: e.target.checked })}
        />
        Flach-km statt Zeit anzeigen
      </label>

      <p className="net-note">Profil / Steigung / Untergrund lösen einen Worker-Call aus. Fitness / Budget / Flach-km sind rein clientseitig.</p>
    </div>
  );
}
