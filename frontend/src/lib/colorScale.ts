/**
 * Time-band colour scale for the effort field.
 *
 * Always {@link N_BANDS} equally spaced bands; the band width follows the budget,
 * so the spacing is constant within a scale and the colours always span the
 * whole palette:
 *
 *   budget <= 4 h   -> 30 min bands   (0-0.5, 0.5-1, ... 3.5-4 h)
 *   budget <= 8 h   ->  1 h bands     (0-1, ... 7-8 h)
 *   budget <= 16 h  ->  2 h bands     (0-2, ... 14-16 h)
 *
 * A shorter budget inside a scale simply shows fewer bands (2 h = the first four
 * 30-min bands), so the colour of a given time never changes while the budget
 * slider moves inside one scale.
 *
 * The palette is "Alpenglühen": pale gold near the start, through orange and
 * rose to deep night blue. It falls monotonically in lightness, which keeps the
 * order readable for colour-blind riders too (the spec's "farbenblind-tauglich").
 *
 * Times here are *displayed* seconds, i.e. after the flat-speed rescale.
 */

export const N_BANDS = 8;

/** Alpenglühen, near -> far. */
export const PALETTE_STOPS: readonly string[] = [
  '#fff3b0', '#ffd166', '#f4a259', '#e76f51', '#c44569', '#8e3b8f', '#5b3d99', '#2e3a87', '#1d2b5c',
];

/** Band width in seconds for a budget in hours. */
export function bandStepS(budgetHours: number): number {
  if (budgetHours <= 4) return 30 * 60;
  if (budgetHours <= 8) return 60 * 60;
  return 120 * 60;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: readonly number[]): string {
  return '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
}

/** Palette colour at `t` in 0..1 (linear in RGB between the stops). */
export function samplePalette(t: number): string {
  const stops = PALETTE_STOPS.map(hexToRgb);
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  return rgbToHex(stops[i].map((c, k) => c + (stops[i + 1][k] - c) * f));
}

/** The {@link N_BANDS} band colours, near -> far. */
export const BAND_COLORS: readonly string[] = Array.from({ length: N_BANDS }, (_, k) =>
  samplePalette(k / (N_BANDS - 1)),
);

/** Band 0..N_BANDS-1 for a displayed time; times past the last band clamp to it. */
export function bandIndex(timeS: number, budgetHours: number): number {
  return Math.min(N_BANDS - 1, Math.max(0, Math.floor(timeS / bandStepS(budgetHours))));
}

export function colorForTime(timeS: number, budgetHours: number): string {
  return BAND_COLORS[bandIndex(timeS, budgetHours)];
}

/** "0:30", "1 h", "1:30" -- compact clock labels for band edges. */
export function formatHours(seconds: number): string {
  const min = Math.round(seconds / 60);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h} h`;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** Legend entries for the bands a budget actually shows. */
export function legendBands(budgetHours: number): Array<{ color: string; from: string; to: string }> {
  const step = bandStepS(budgetHours);
  const shown = Math.min(N_BANDS, Math.ceil((budgetHours * 3600) / step - 1e-9));
  return Array.from({ length: shown }, (_, k) => ({
    color: BAND_COLORS[k],
    from: k === 0 ? '0' : formatHours(k * step),
    to: formatHours(Math.min((k + 1) * step, budgetHours * 3600)),
  }));
}
