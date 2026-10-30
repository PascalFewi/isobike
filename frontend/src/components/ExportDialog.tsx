/**
 * "GPX exportieren": the whole tour once more before the download -- stats,
 * surface, elevation profile, waypoints and legs, the settings it was computed
 * with -- and what a rider must know before relying on it: check the ways, mind
 * the signs, no liability.
 *
 * A native <dialog>: the browser brings the modal backdrop, Escape and focus
 * handling.
 */

import { useEffect, useRef, type ReactNode } from 'react';

import { BIKES, formLabel, profileLabel, type ControlState } from './Controls.tsx';
import { Facts, LegLine, SurfaceBar, hm, km, routeTotals, type LegView } from './Planner.tsx';
import type { SurfaceKey } from '../lib/surface.ts';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDownload: () => void;
  readonly name: string;
  readonly controls: ControlState;
  readonly waypoints: ReadonlyArray<{ readonly letter: string; readonly label: string }>;
  readonly legs: ReadonlyArray<LegView | null>;
  readonly surfaceM: Readonly<Record<SurfaceKey, number>>;
  /** The elevation profile, or null without a route line. */
  readonly profile: ReactNode;
}

export function ExportDialog(props: Props): JSX.Element {
  const { open, onClose, controls, waypoints, legs } = props;
  const dialog = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d === null) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const total = routeTotals(legs);
  const bike = BIKES.find((b) => b.key === controls.bike);

  return (
    <dialog
      ref={dialog}
      className="export-dialog"
      aria-labelledby="export-title"
      // Escape and the close button both end here; keep the app's state in step.
      onClose={onClose}
      // A click on the backdrop (the dialog element itself, outside its content) closes it.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <>
          <div className="export-body">
            <header className="export-head">
              <h2 id="export-title">{props.name}</h2>
              <small>GPX-Export</small>
            </header>

            <section className="totals" aria-label="Gesamt">
              <div className="big"><strong>{hm(total.timeS)}</strong><span>Fahrzeit</span></div>
              <div className="big"><strong>{km(total.distM)}</strong><span>Distanz</span></div>
              <Facts total={total} />
              <SurfaceBar surfaceM={props.surfaceM} />
            </section>

            {props.profile}

            <section aria-label="Wegpunkte">
              <h3>Wegpunkte</h3>
              <ol className="export-legs">
                {waypoints.map((w, i) => (
                  <li key={`${w.letter}-${i}`}>
                    <span className={`badge${i === 0 ? ' start' : ''}`}>{w.letter}</span>
                    <span>{w.label}</span>
                    {i < legs.length && <LegLine leg={legs[i]} />}
                  </li>
                ))}
              </ol>
            </section>

            <section aria-label="Berechnet mit">
              <h3>Berechnet mit</h3>
              <div className="export-settings">
                <span>Fahrrad <strong>{bike?.label}</strong></span>
                <span>Profil <strong>{profileLabel(controls.profileT)}</strong></span>
                <span>Form <strong>{formLabel(controls.flatKmh)}</strong></span>
                <span>Max. Steigung <strong>{controls.maxSlope === null ? 'aus' : `${controls.maxSlope} %`}</strong></span>
              </div>
            </section>

            <section aria-label="Hinweise">
              <h3>Bitte beachten</h3>
              <ul className="export-notes">
                <li>
                  Die Route ist automatisch aus OpenStreetMap-Daten berechnet. <strong>Prüfe vor der Fahrt, ob alle Wege
                  offen und für Velos erlaubt sind</strong>: Sperrungen, Baustellen, Fahrverbote und der Zustand der Wege
                  können abweichen.
                </li>
                <li>Signalisation und Verkehrsregeln vor Ort gehen der Route immer vor.</li>
                <li>
                  Fahrzeit und Höhenmeter sind Schätzungen aus deinem Profil und Höhenmodellen. Pausen, Wind, Wetter und
                  Verkehr sind nicht eingerechnet.
                </li>
                <li>Auf Schotter und Naturwegen: Verhältnisse und Wetter prüfen, genug Wasser, Licht und Ersatzteile mitnehmen.</li>
              </ul>
            </section>

            <p className="export-liability">
              <strong>Haftungsausschluss:</strong> Die Nutzung der Route erfolgt auf eigene Verantwortung. Für Richtigkeit,
              Vollständigkeit, Aktualität und Befahrbarkeit der Route sowie für Schäden aus ihrer Nutzung wird keine
              Haftung übernommen. Kartendaten © OpenStreetMap-Mitwirkende (ODbL).
            </p>
          </div>

          <div className="export-actions">
            <button type="button" className="secondary" onClick={onClose}>Schliessen</button>
            <button
              type="button"
              onClick={() => {
                props.onDownload();
                onClose();
              }}
            >
              GPX herunterladen
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
