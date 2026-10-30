/**
 * Two buttons on the map, bottom left, each opening a small panel above it:
 *
 * - bike: the rider -- Profil, Form, max. slope (RiderSettings)
 * - map:  what the map shows -- isochrones, road types, cycling POIs, each with its legend
 *
 * One panel at a time; a click outside or Escape closes it.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Legend, RiderSettings, type ControlState } from './Controls.tsx';
import { ROAD_INFO, ROAD_KINDS } from '../lib/mapStyle.ts';
import { POI_INFO, POI_KINDS, poiIconUrl } from '../lib/pois.ts';

interface Props {
  readonly state: ControlState;
  readonly vamHmh: number;
  readonly onChange: (patch: Partial<ControlState>) => void;
}

type Menu = 'bike' | 'map';

const DASH_SVG = { solid: undefined, dashed: '5 3', dotted: '0.5 3.5' } as const;

export function MapButtons({ state, vamHmh, onChange }: Props): JSX.Element {
  const [open, setOpen] = useState<Menu | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: PointerEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (m: Menu): void => setOpen((o) => (o === m ? null : m));

  return (
    <div className="map-buttons" ref={box}>
      {open === 'bike' && (
        <MenuPanel id="menu-bike" label="Fahrer">
          <RiderSettings state={state} vamHmh={vamHmh} onChange={onChange} />
        </MenuPanel>
      )}
      {open === 'map' && (
        <MenuPanel id="menu-map" label="Karteneinstellungen">
          <div className="ctl">
            <Check id="ctl-iso" label="Isochronen" checked={state.isochrones} onChange={(v) => onChange({ isochrones: v })} />
            {state.isochrones && <Legend budgetHours={state.budgetHours} />}
          </div>
          <div className="ctl">
            <Check id="ctl-roads" label="Strassentypen" checked={state.roadTypes} onChange={(v) => onChange({ roadTypes: v })} />
            {state.roadTypes && (
              <ul className="road-legend">
                {ROAD_KINDS.map((k) => (
                  <li key={k}>
                    <svg width="24" height="8" aria-hidden="true">
                      <line
                        x1="1" y1="4" x2="23" y2="4" stroke={ROAD_INFO[k].color}
                        strokeWidth={Math.min(3.5, ROAD_INFO[k].width)}
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
            <Check id="ctl-pois" label="Velo-Infos" checked={state.pois} onChange={(v) => onChange({ pois: v })} />
            {state.pois && (
              <ul className="poi-legend">
                {POI_KINDS.map((k) => (
                  <li key={k}>
                    <img src={poiIconUrl(k)} alt="" width={14} height={14} />
                    {POI_INFO[k].label}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </MenuPanel>
      )}
      <div className="map-buttons-row">
        <MenuButton menu="bike" open={open} label="Fahrer: Profil, Form, Steigung" onClick={toggle}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="5.5" cy="16.5" r="3.5" />
            <circle cx="18.5" cy="16.5" r="3.5" />
            <path d="M5.5 16.5 9 9h7l2.5 7.5M9 9l3 7.5L16 9M8 6.5h3M15 6l1 3" />
          </svg>
        </MenuButton>
        <MenuButton menu="map" open={open} label="Karteneinstellungen" onClick={toggle}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5L9 4Z" />
            <path d="M9 4v13.5M15 6.5V20" />
          </svg>
        </MenuButton>
      </div>
    </div>
  );
}

function MenuButton({
  menu,
  open,
  label,
  onClick,
  children,
}: {
  readonly menu: Menu;
  readonly open: Menu | null;
  readonly label: string;
  readonly onClick: (m: Menu) => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button" className="map-button" aria-label={label} title={label}
      aria-expanded={open === menu} aria-controls={`menu-${menu}`}
      onClick={() => onClick(menu)}
    >
      {children}
    </button>
  );
}

function MenuPanel({ id, label, children }: { readonly id: string; readonly label: string; readonly children: ReactNode }): JSX.Element {
  return (
    <div className="panel map-menu" id={id} role="group" aria-label={label}>
      {children}
    </div>
  );
}

function Check({
  id,
  label,
  checked,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="check" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="ctl-head">{label}</span>
    </label>
  );
}
