/**
 * Left panel, after komoot: time budget and bike on top, then the route as a
 * list of waypoints (each also typed as a place), the totals and the legs, and
 * the GPX export.
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import type { Place } from '../lib/geocode.ts';
import { SURFACES, SURFACE_INFO, type SurfaceKey } from '../lib/surface.ts';
import { dropIndex } from '../lib/waypoints.ts';
import { GitHubIcon, REPO_URL } from './Footer.tsx';
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
  /** Budget and bike controls (Controls.tsx), shown under the title. */
  readonly trip: ReactNode;
  readonly legs: ReadonlyArray<LegView | null>;
  /** Metres per surface over the whole route. */
  readonly surfaceM: Readonly<Record<SurfaceKey, number>>;
  readonly canExport: boolean;
  readonly onSetPlace: (index: number, place: Place) => void;
  readonly onAddPlace: (place: Place) => void;
  readonly onRemove: (index: number) => void;
  readonly onShift: (index: number, delta: -1 | 1) => void;
  /** Drag and drop in the list: the waypoint at `from` to index `to`. */
  readonly onMove: (from: number, to: number) => void;
  readonly onReverse: () => void;
  /** Same way back: the waypoints again in reverse. */
  readonly onRoundTrip: () => void;
  readonly onClear: () => void;
  readonly onExport: () => void;
}

export function hm(seconds: number): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

export function km(m: number): string {
  return `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

export interface RouteTotals {
  readonly timeS: number;
  readonly distM: number;
  readonly ascentM: number;
  readonly descentM: number;
  readonly maxSlopePct: number;
}

/** The found legs summed up; the planner and the export dialog show the same numbers. */
export function routeTotals(legs: ReadonlyArray<LegView | null>): RouteTotals {
  const done = legs.filter((l): l is LegView => l !== null && l.found);
  return {
    timeS: done.reduce((s, l) => s + l.timeS, 0),
    distM: done.reduce((s, l) => s + l.distM, 0),
    ascentM: done.reduce((s, l) => s + l.ascentM, 0),
    descentM: done.reduce((s, l) => s + l.descentM, 0),
    maxSlopePct: done.reduce((s, l) => Math.max(s, l.maxSlopePct), 0),
  };
}

/** Ascent, descent, steepest stretch, average speed: the small facts line. */
export function Facts({ total }: { readonly total: RouteTotals }): JSX.Element {
  return (
    <div className="small">
      <span title="Aufstieg">↑ {Math.round(total.ascentM)} Hm</span>
      <span title="Abstieg">↓ {Math.round(total.descentM)} Hm</span>
      <span title="steilste 200 m">max {total.maxSlopePct.toFixed(1)} %</span>
      {total.timeS > 0 && <span title="Durchschnittsgeschwindigkeit">Ø {((total.distM / total.timeS) * 3.6).toFixed(1)} km/h</span>}
    </div>
  );
}

export function Planner(props: Props): JSX.Element {
  const { waypoints, legs } = props;
  const rows = useRef<Array<HTMLLIElement | null>>([]);
  /** A badge being dragged: its row and where it would land. */
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  const landing = (from: number, y: number): number =>
    dropIndex(
      waypoints.map((_, i) => {
        const r = rows.current[i]?.getBoundingClientRect();
        return r === undefined ? 0 : r.top + r.height / 2;
      }),
      from,
      y,
    );
  const dragStart = (e: ReactPointerEvent, i: number): void => {
    if (waypoints.length < 2) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: i, to: i });
  };
  const dragMove = (e: ReactPointerEvent): void => {
    if (drag !== null) setDrag({ from: drag.from, to: landing(drag.from, e.clientY) });
  };
  const dragEnd = (): void => {
    if (drag !== null && drag.to !== drag.from) props.onMove(drag.from, drag.to);
    setDrag(null);
  };
  /** Drop line above or below a row, where the dragged one would go. */
  const dropMark = (i: number): string => {
    if (drag === null || drag.to === drag.from || i !== drag.to) return '';
    return drag.to < drag.from ? ' drop-above' : ' drop-below';
  };
  const broken = legs.some((l) => l !== null && !l.found);
  const total = routeTotals(legs);

  return (
    <aside className="panel planner" aria-label="Route">
      <header className="brand">
        <h1>
          VeloRouter
          <a
            className="gh" href={REPO_URL} target="_blank" rel="noopener noreferrer"
            title="Code, Fragen und Feedback auf GitHub" aria-label="isobike auf GitHub"
          >
            <GitHubIcon />
          </a>
        </h1>
        {waypoints.length > 0 && (
          <button type="button" className="link" onClick={props.onClear}>Neu</button>
        )}
      </header>

      {props.trip}

      {waypoints.length >= 2 && (
        <section className="totals" aria-label="Gesamt">
          <div className="big"><strong>{hm(total.timeS)}</strong><span>Fahrzeit</span></div>
          <div className="big"><strong>{km(total.distM)}</strong><span>Distanz</span></div>
          <Facts total={total} />
          <SurfaceBar surfaceM={props.surfaceM} />
          {broken && <p className="warn">Ein Abschnitt ist mit diesen Filtern nicht befahrbar.</p>}
        </section>
      )}

      <ol className="waypoints">
        {waypoints.map((w, i) => (
          <li
            key={w.key}
            ref={(el) => {
              rows.current[i] = el;
            }}
            className={`${drag?.from === i ? 'dragging' : ''}${dropMark(i)}`}
          >
            <span
              className={`badge${i === 0 ? ' start' : ''}${waypoints.length > 1 ? ' grab' : ''}`}
              title={waypoints.length > 1 ? 'Ziehen, um die Reihenfolge zu ändern' : undefined}
              onPointerDown={(e) => dragStart(e, i)}
              onPointerMove={dragMove}
              onPointerUp={dragEnd}
              onPointerCancel={() => setDrag(null)}
            >
              {w.letter}
            </span>
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
            {i < legs.length ? (
              <LegLine leg={legs[i]} />
            ) : (
              // The last point has no leg after it: keep the line, so the add row sits at the same distance.
              <div className="leg" aria-hidden="true">&nbsp;</div>
            )}
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
        <button type="button" className="secondary" disabled={waypoints.length < 2} onClick={props.onRoundTrip}>Hin und zurück</button>
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

/** Belag: one stacked bar plus km per surface, like komoot's way types. */
export function SurfaceBar({ surfaceM }: { readonly surfaceM: Readonly<Record<SurfaceKey, number>> }): JSX.Element | null {
  const total = SURFACES.reduce((s, k) => s + surfaceM[k], 0);
  if (total <= 0) return null;
  const shown = SURFACES.filter((k) => surfaceM[k] > 0);
  return (
    <div className="surface" aria-label="Belag">
      <div className="surface-bar">
        {shown.map((k) => (
          <i key={k} style={{ width: `${(100 * surfaceM[k]) / total}%`, background: SURFACE_INFO[k].color }} />
        ))}
      </div>
      <ul className="surface-list">
        {shown.map((k) => (
          <li key={k}>
            <i style={{ background: SURFACE_INFO[k].color }} />
            {SURFACE_INFO[k].label} {km(surfaceM[k])}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LegLine({ leg }: { readonly leg: LegView | null }): JSX.Element {
  if (leg === null) return <div className="leg loading">berechne…</div>;
  if (!leg.found) return <div className="leg none">nicht erreichbar</div>;
  return (
    <div className="leg">
      {hm(leg.timeS)} · {km(leg.distM)} · ↑ {Math.round(leg.ascentM)} · ↓ {Math.round(leg.descentM)}
    </div>
  );
}
