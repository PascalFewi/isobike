/**
 * Time-band colour scale for the effort field, plus the second (cumulative
 * ascent) channel and the flat-km conversion.
 *
 * Colour = time to reach. The palette is **viridis**, chosen because the spec
 * requires it be colour-blind-friendly ("farbenblind-tauglich"): viridis is
 * perceptually uniform and legible under deuteranopia, protanopia and
 * tritanopia. A red-green isochrone ramp -- the obvious choice -- would fail
 * exactly that requirement, so it is avoided on purpose.
 *
 * The band thresholds are in seconds *after* the Fitness rescale, so a fitter
 * rider's bands cover more ground without a re-route (see profile.ts).
 */

/** Band upper bounds in seconds: 30 min, 1 h, 2 h, 4 h, 8 h -> six bands. */
export const BAND_BOUNDS_S: readonly number[] = [
  30 * 60, 60 * 60, 120 * 60, 240 * 60, 480 * 60,
];

/**
 * Six viridis stops, closest -> farthest. Closest reach is bright yellow (stands
 * out around the start); farthest is deep viridis purple.
 */
export const PALETTE: readonly string[] = [
  '#fde725', // < 30 min
  '#7ad151', // 30-60 min
  '#22a884', // 1-2 h
  '#2a788e', // 2-4 h
  '#414487', // 4-8 h
  '#440154', // > 8 h
];

/** Band index 0..5 for a reach time in seconds. */
export function bandIndex(timeSeconds: number): number {
  for (let i = 0; i < BAND_BOUNDS_S.length; i++) {
    if (timeSeconds < BAND_BOUNDS_S[i]) return i;
  }
  return BAND_BOUNDS_S.length; // the final open-ended band
}

export function colorForTime(timeSeconds: number): string {
  return PALETTE[bandIndex(timeSeconds)];
}

/** Human labels for the legend. */
export const BAND_LABELS: readonly string[] = [
  '< 30 min', '30–60 min', '1–2 h', '2–4 h', '4–8 h', '> 8 h',
];

/**
 * Second channel: cumulative-ascent intensity, 0..1, for the map to render as a
 * pattern or reduced lightness over the time colour. Normalised against the
 * field's own max so it is meaningful at any zoom/region.
 */
export function ascentIntensity(cumAscentM: number, maxCumAscentM: number): number {
  if (maxCumAscentM <= 0) return 0;
  return Math.min(1, Math.max(0, cumAscentM / maxCumAscentM));
}

/**
 * Flat-equivalent distance (km) for a reach time -- the "Flach-km" toggle.
 * `flat_km = time * v_flat`. Lets a rider read the colour as distance instead of
 * clock time.
 */
export function timeToFlatKm(timeSeconds: number, vFlatMps: number): number {
  return (timeSeconds * vFlatMps) / 1000;
}
