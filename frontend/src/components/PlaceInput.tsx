/**
 * A waypoint field: shows the waypoint's name, and on typing searches swisstopo
 * for places (debounced, previous request aborted) and offers them in a list.
 * Arrow keys + Enter pick, Escape closes.
 */

import { useEffect, useRef, useState } from 'react';

import { searchPlaces, type Place } from '../lib/geocode.ts';

interface Props {
  readonly id: string;
  readonly value: string;
  readonly placeholder: string;
  readonly onPick: (place: Place) => void;
}

const DEBOUNCE_MS = 250;

export function PlaceInput({ id, value, placeholder, onPick }: Props): JSX.Element {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  const [results, setResults] = useState<Place[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);

  useEffect(() => {
    if (!editing || text.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      abort.current?.abort();
      const ctl = new AbortController();
      abort.current = ctl;
      searchPlaces(text, ctl.signal)
        .then((r) => {
          setResults(r);
          setActive(0);
          setError(null);
        })
        .catch((e: unknown) => {
          if ((e as { name?: string }).name !== 'AbortError') setError(String(e));
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, editing]);

  const pick = (p: Place): void => {
    onPick(p);
    setEditing(false);
    setResults([]);
  };

  return (
    <div className="place">
      <input
        id={id}
        type="text"
        value={text}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls={`${id}-list`}
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
        }}
        onBlur={() => setTimeout(() => setEditing(false), 150)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(results.length - 1, a + 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
          else if (e.key === 'Enter' && results[active] !== undefined) pick(results[active]);
          else if (e.key === 'Escape') {
            setEditing(false);
            e.currentTarget.blur();
          }
        }}
      />
      {editing && results.length > 0 && (
        <ul className="suggest" id={`${id}-list`} role="listbox">
          {results.map((r, i) => (
            <li
              key={`${r.label}-${r.lat}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(r);
              }}
            >
              {r.label}
            </li>
          ))}
        </ul>
      )}
      {editing && error !== null && <div className="suggest-error">{error}</div>}
    </div>
  );
}
