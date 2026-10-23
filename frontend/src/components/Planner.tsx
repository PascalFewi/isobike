/**
 * Left panel, after komoot: the route as a list of waypoints (each also typed as
 * a place), the totals and the legs, and the GPX export.
 */

import type { Place } from '../lib/geocode.ts';
import { PlaceInput } from './PlaceInput.tsx';

export interface PlannerWaypoint {
  readonly key: number;
  readonly letter: string;
  readonly label: string;
}

/** A leg's figures, in displayed (rider) time. `null` while it is loading. */
export interface LegView {
  readonly found: boolean;
  readonly timeS: number;
  readonly distM: number;
  readonly ascentM: number;
  readonly descentM: number;
  readonly maxSlopePct: number;
}

interface Props {
  readonly waypoints: readonly PlannerWaypoint[];
  readonly legs: ReadonlyArray<LegView | null>;
  readonly canExport: boolean;
  readonly onSetPlace: (index: number, place: Place) => void;
  readonly onAddPlace: (place: Place) => void;
  readonly onRemove: (index: number) => void;
  readonly onShift: (index: number, delta: -1 | 1) => void;
  readonly onReverse: () => void;
  readonly onClear: () => void;
  readonly onExport: () => void;
}

export function hm(seconds: number): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

function km(m: number): string {
  return `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

export function Planner(props: Props): JSX.Element {
  const { waypoints, legs } = props;
  const done = legs.filter((l): l is LegView => l !== null && l.found);
  const broken = legs.some((l) => l !== null && !l.found);
  const total = {
    timeS: done.reduce((s, l) => s + l.timeS, 0),
    distM: done.reduce((s, l) => s + l.distM, 0),
    ascentM: done.reduce((s, l) => s + l.ascentM, 0),
    descentM: done.reduce((s, l) => s + l.descentM, 0),
    maxSlopePct: done.reduce((s, l) => Math.max(s, l.maxSlopePct), 0),
  };

  return (
    <aside className="panel planner" aria-label="Route">
      <header className="brand">
        <h1>
          VeloRouter
          <a
            className="gh" href="https://github.com/PascalFewi/isobike" target="_blank" rel="noopener noreferrer"
            title="Code, Fragen und Feedback auf GitHub" aria-label="isobike auf GitHub"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>
        </h1>
        {waypoints.length > 0 && (
          <button type="button" className="link" onClick={props.onClear}>Neu</button>
        )}
      </header>

      {waypoints.length >= 2 && (
        <section className="totals" aria-label="Gesamt">
          <div className="big"><strong>{hm(total.timeS)}</strong><span>Fahrzeit</span></div>
          <div className="big"><strong>{km(total.distM)}</strong><span>Distanz</span></div>
          <div className="small">
            <span title="Aufstieg">↑ {Math.round(total.ascentM)} Hm</span>
            <span title="Abstieg">↓ {Math.round(total.descentM)} Hm</span>
            <span title="steilste 200 m">max {total.maxSlopePct.toFixed(1)} %</span>
          </div>
          {broken && <p className="warn">Ein Abschnitt ist mit diesen Filtern nicht befahrbar.</p>}
        </section>
      )}

      <ol className="waypoints">
        {waypoints.map((w, i) => (
          <li key={w.key}>
            <span className={`badge${i === 0 ? ' start' : ''}`}>{w.letter}</span>
            <PlaceInput
              id={`wp-${w.key}`}
              value={w.label}
              placeholder={i === 0 ? 'Startort' : 'Ort'}
              onPick={(p) => props.onSetPlace(i, p)}
            />
            <span className="row-actions">
              <button type="button" aria-label={`${w.letter} nach oben`} disabled={i === 0} onClick={() => props.onShift(i, -1)}>↑</button>
              <button type="button" aria-label={`${w.letter} nach unten`} disabled={i === waypoints.length - 1} onClick={() => props.onShift(i, 1)}>↓</button>
              <button type="button" aria-label={`${w.letter} entfernen`} onClick={() => props.onRemove(i)}>×</button>
            </span>
            {i < legs.length && <LegLine leg={legs[i]} />}
          </li>
        ))}
        <li className="add">
          <span className="badge ghost">+</span>
          <PlaceInput
            id="wp-new"
            value=""
            placeholder={waypoints.length === 0 ? 'Startort suchen oder Karte klicken' : 'Nächsten Punkt suchen oder Karte klicken'}
            onPick={props.onAddPlace}
          />
        </li>
      </ol>

      <div className="actions">
        <button type="button" disabled={!props.canExport} onClick={props.onExport}>GPX exportieren</button>
        <button type="button" className="secondary" disabled={waypoints.length < 2} onClick={props.onReverse}>Umkehren</button>
      </div>

      {waypoints.length === 0 && (
        <p className="intro">
          Klick setzt den Start: die Karte zeigt, wohin du im Zeitbudget kommst. Jeder weitere Klick hängt
          einen Abschnitt an, und die Einfärbung rechnet ab dem letzten Punkt weiter.
        </p>
      )}
    </aside>
  );
}

function LegLine({ leg }: { readonly leg: LegView | null }): JSX.Element {
  if (leg === null) return <div className="leg loading">berechne…</div>;
  if (!leg.found) return <div className="leg none">nicht erreichbar</div>;
  return (
    <div className="leg">
      {hm(leg.timeS)} · {km(leg.distM)} · ↑ {Math.round(leg.ascentM)} · ↓ {Math.round(leg.descentM)}
    </div>
  );
}
