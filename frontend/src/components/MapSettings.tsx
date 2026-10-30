/**
 * Map button, bottom left: opens what the map shows on top of the basemap --
 * road types and the cycling POIs, each with its legend. These change only the
 * display, so they sit on the map rather than in the rider settings. Closes on
 * a click outside or Escape.
 */

import { useEffect, useRef, useState } from 'react';

import type { ControlState } from './Controls.tsx';
import { ROAD_INFO, ROAD_KINDS } from '../lib/mapStyle.ts';
import { POI_INFO, POI_KINDS, poiIconUrl } from '../lib/pois.ts';

interface Props {
  readonly roadTypes: boolean;
  readonly pois: boolean;
  readonly onChange: (patch: Partial<ControlState>) => void;
}

const DASH_SVG = { solid: undefined, dashed: '5 3', dotted: '0.5 3.5' } as const;

export function MapSettings({ roadTypes, pois, onChange }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="map-settings" ref={box}>
      {open && (
        <div className="panel map-settings-panel" id="map-settings-panel" role="group" aria-label="Karteneinstellungen">
          <div className="ctl">
            <label className="check" htmlFor="ctl-roads">
              <input
                id="ctl-roads" type="checkbox" checked={roadTypes}
                onChange={(e) => onChange({ roadTypes: e.target.checked })}
              />
              <span className="ctl-head">Strassentypen</span>
            </label>
            {roadTypes && (
              <ul className="road-legend">
                {ROAD_KINDS.map((k) => (
                  <li key={k}>
                    <svg width="26" height="8" aria-hidden="true">
                      <line
                        x1="1" y1="4" x2="25" y2="4" stroke={ROAD_INFO[k].color}
                        strokeWidth={Math.min(4, ROAD_INFO[k].width)}
                        strokeDasharray={DASH_SVG[ROAD_INFO[k].dash]}
                        strokeLinecap={ROAD_INFO[k].dash === 'dotted' ? 'round' : 'butt'}
                      />
                    </svg>
                    {ROAD_INFO[k].label}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="ctl">
            <label className="check" htmlFor="ctl-pois">
              <input
                id="ctl-pois" type="checkbox" checked={pois}
                onChange={(e) => onChange({ pois: e.target.checked })}
              />
              <span className="ctl-head">Velo-Infos auf der Karte</span>
            </label>
            {pois && (
              <ul className="poi-legend">
                {POI_KINDS.map((k) => (
                  <li key={k}>
                    <img src={poiIconUrl(k)} alt="" width={16} height={16} />
                    {POI_INFO[k].label}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      <button
        type="button" className="map-settings-toggle"
        aria-label="Karteneinstellungen" title="Karteneinstellungen"
        aria-expanded={open} aria-controls="map-settings-panel"
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5L9 4Z" />
          <path d="M9 4v13.5M15 6.5V20" />
        </svg>
      </button>
    </div>
  );
}
