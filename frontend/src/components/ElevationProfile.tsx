/**
 * Bottom panel: the route's elevation profile over distance, with the waypoint
 * positions marked. Hovering reports the vertex under the pointer so the map can
 * show where on the route that is.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { cumulativeDistance, type Coord } from '../lib/gpx.ts';

interface Props {
  readonly coords: readonly Coord[];
  /** Vertex index where each waypoint after the start sits. */
  readonly stops: readonly number[];
  readonly letters: readonly string[];
  readonly onHover: (index: number | null) => void;
}

const H = 132;
const PAD = { l: 44, r: 12, t: 12, b: 22 };

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
}

export function ElevationProfile({ coords, stops, letters, onHover }: Props): JSX.Element {
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const [hoverI, setHoverI] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dist = useMemo(() => cumulativeDistance(coords), [coords]);
  const total = dist[dist.length - 1] ?? 0;
  const [zMin, zMax] = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of coords) {
      lo = Math.min(lo, c[2]);
      hi = Math.max(hi, c[2]);
    }
    const pad = Math.max(20, (hi - lo) * 0.08);
    return [Math.floor((lo - pad) / 10) * 10, Math.ceil((hi + pad) / 10) * 10];
  }, [coords]);

  const W = width;
  const x = (d: number): number => PAD.l + (total > 0 ? (d / total) * (W - PAD.l - PAD.r) : 0);
  const y = (z: number): number => PAD.t + (1 - (z - zMin) / (zMax - zMin || 1)) * (H - PAD.t - PAD.b);

  const path = useMemo(() => {
    if (coords.length < 2) return { line: '', area: '' };
    // At most ~2 points per pixel: keep the per-bucket extremes so peaks survive.
    const pts: string[] = [];
    const bucket = Math.max(1, Math.floor(coords.length / (W * 2)));
    for (let i = 0; i < coords.length; i += bucket) {
      let best = i;
      for (let k = i; k < Math.min(coords.length, i + bucket); k++) if (coords[k][2] > coords[best][2]) best = k;
      pts.push(`${x(dist[best]).toFixed(1)},${y(coords[best][2]).toFixed(1)}`);
    }
    const last = coords.length - 1;
    pts.push(`${x(dist[last]).toFixed(1)},${y(coords[last][2]).toFixed(1)}`);
    const line = `M${pts.join('L')}`;
    return { line, area: `${line}L${x(total).toFixed(1)},${H - PAD.b}L${PAD.l},${H - PAD.b}Z` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords, dist, W, zMin, zMax]);

  const zStep = niceStep(zMax - zMin, 3);
  const zTicks: number[] = [];
  for (let z = Math.ceil(zMin / zStep) * zStep; z <= zMax; z += zStep) zTicks.push(z);
  const kmStep = niceStep(total / 1000, Math.max(3, Math.floor(W / 110)));
  const kmTicks: number[] = [];
  for (let k = 0; k <= total / 1000 + 1e-9; k += kmStep) kmTicks.push(k);

  const pick = (clientX: number): void => {
    const el = box.current;
    if (el === null || coords.length < 2) return;
    const r = el.getBoundingClientRect();
    const d = ((clientX - r.left - PAD.l) / (W - PAD.l - PAD.r)) * total;
    let lo = 0;
    let hi = dist.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dist[mid] < d) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(0, Math.min(coords.length - 1, lo));
    setHoverI(i);
    onHover(i);
  };

  const hv = hoverI !== null && hoverI < coords.length ? hoverI : null;
  const grade = (() => {
    if (hv === null) return null;
    // Grade over ~200 m around the pointer.
    let a = hv;
    let b = hv;
    while (a > 0 && dist[hv] - dist[a] < 100) a--;
    while (b < coords.length - 1 && dist[b] - dist[hv] < 100) b++;
    const run = dist[b] - dist[a];
    return run > 0 ? ((coords[b][2] - coords[a][2]) / run) * 100 : 0;
  })();

  return (
    <section className="panel profile" aria-label="Höhenprofil">
      <div
        ref={box}
        className="profile-plot"
        onMouseMove={(e) => pick(e.clientX)}
        onMouseLeave={() => {
          setHoverI(null);
          onHover(null);
        }}
      >
        <svg width={W} height={H} role="img" aria-label="Höhenprofil der Route">
          {zTicks.map((z) => (
            <g key={`z${z}`}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(z)} y2={y(z)} className="grid" />
              <text x={PAD.l - 6} y={y(z) + 4} className="tick" textAnchor="end">{z}</text>
            </g>
          ))}
          {kmTicks.map((k) => (
            <text key={`k${k}`} x={x(k * 1000)} y={H - 6} className="tick" textAnchor="middle">{k} km</text>
          ))}
          <path d={path.area} className="area" />
          <path d={path.line} className="line" />
          {stops.map((s, i) => (
            <g key={`s${i}`}>
              <line x1={x(dist[s] ?? 0)} x2={x(dist[s] ?? 0)} y1={PAD.t} y2={H - PAD.b} className="stop" />
              <text x={x(dist[s] ?? 0)} y={PAD.t + 10} className="stop-label" textAnchor="middle">{letters[i + 1]}</text>
            </g>
          ))}
          {hv !== null && (
            <g>
              <line x1={x(dist[hv])} x2={x(dist[hv])} y1={PAD.t} y2={H - PAD.b} className="cursor" />
              <circle cx={x(dist[hv])} cy={y(coords[hv][2])} r={4} className="cursor-dot" />
            </g>
          )}
        </svg>
        {hv !== null && (
          <div className="readout" style={{ left: Math.min(W - 170, Math.max(PAD.l, x(dist[hv]) + 10)) }}>
            {(dist[hv] / 1000).toFixed(1)} km · {Math.round(coords[hv][2])} m · {grade!.toFixed(1)} %
          </div>
        )}
      </div>
    </section>
  );
}
