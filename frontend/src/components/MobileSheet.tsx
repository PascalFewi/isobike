/**
 * Phone layout: the map stays clear, and the panels share one bottom sheet with
 * tabs instead of floating over the map. Tapping the open tab (or the arrow)
 * folds the sheet down to its tab bar; the legend stays visible either way.
 * Panels stay mounted while hidden, so a half-typed place survives a tab switch.
 * The sheet reports its height so the map's bottom controls sit above it.
 */

import { useEffect, useRef } from 'react';

export type SheetTab = 'route' | 'settings' | 'profile';

interface Props {
  /** The open tab, or `null` when the sheet is folded down. */
  readonly tab: SheetTab | null;
  readonly onTab: (tab: SheetTab | null) => void;
  /** A `null` panel has no tab (the profile before there is a route). */
  readonly panels: Readonly<Record<SheetTab, JSX.Element | null>>;
  readonly legend: JSX.Element | null;
  readonly onHeight: (px: number) => void;
}

const LABELS: Record<SheetTab, string> = { route: 'Route', settings: 'Einstellungen', profile: 'Höhenprofil' };

export function MobileSheet({ tab, onTab, panels, legend, onHeight }: Props): JSX.Element {
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight]);

  const tabs = (Object.keys(LABELS) as SheetTab[]).filter((k) => panels[k] !== null);
  return (
    <div className="sheet" ref={box}>
      {legend}
      <div className="sheet-tabs" role="tablist" aria-label="Ansicht">
        {tabs.map((k) => (
          <button
            key={k} type="button" role="tab" id={`tab-${k}`}
            aria-selected={tab === k} aria-controls={`sheet-${k}`}
            onClick={() => onTab(tab === k ? null : k)}
          >
            {LABELS[k]}
          </button>
        ))}
        <button
          type="button" className="sheet-toggle"
          aria-label={tab === null ? 'Aufklappen' : 'Zuklappen'} aria-expanded={tab !== null}
          onClick={() => onTab(tab === null ? 'route' : null)}
        >
          {tab === null ? '▴' : '▾'}
        </button>
      </div>
      {tabs.map((k) => (
        <div key={k} id={`sheet-${k}`} role="tabpanel" aria-labelledby={`tab-${k}`} className="sheet-body" hidden={tab !== k}>
          {panels[k]}
        </div>
      ))}
    </div>
  );
}
