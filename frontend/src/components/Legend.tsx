/**
 * Colour legend for the time bands, plus the flat-km alternative labels. Bands
 * rescale with Fitness, so the legend takes the current factor to show the right
 * boundaries.
 */

import { BAND_BOUNDS_S, BAND_LABELS, PALETTE, timeToFlatKm } from '../lib/colorScale.ts';

interface Props {
  readonly flatKm: boolean;
  readonly vFlatMps: number;
  readonly fitnessFactor: number;
}

function flatKmLabel(i: number, vFlatMps: number, fitnessFactor: number): string {
  // Displayed band boundary = raw boundary * fitness (fitter reaches farther).
  const lo = i === 0 ? 0 : BAND_BOUNDS_S[i - 1] * fitnessFactor;
  const hi = i < BAND_BOUNDS_S.length ? BAND_BOUNDS_S[i] * fitnessFactor : Infinity;
  const loKm = timeToFlatKm(lo, vFlatMps);
  if (!Number.isFinite(hi)) return `> ${loKm.toFixed(0)} km`;
  return `${loKm.toFixed(0)}–${timeToFlatKm(hi, vFlatMps).toFixed(0)} km`;
}

export function Legend({ flatKm, vFlatMps, fitnessFactor }: Props): JSX.Element {
  return (
    <div className="legend">
      <div className="legend-title">{flatKm ? 'Flach-km' : 'Zeit'}</div>
      {PALETTE.map((color, i) => (
        <div className="legend-row" key={color}>
          <span className="swatch" style={{ background: color }} />
          <span>{flatKm ? flatKmLabel(i, vFlatMps, fitnessFactor) : BAND_LABELS[i]}</span>
        </div>
      ))}
      <div className="legend-note">dunkler = mehr Höhenmeter</div>
    </div>
  );
}
