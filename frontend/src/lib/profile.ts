/**
 * Rider profile (Profil slider) and Fitness slider -- the two speed controls that
 * replaced the old alpha slider.
 *
 * **Profil** sets the *ratio* v_flat : vam, i.e. how much a rider trades distance
 * for climbing. It changes route choice, so moving it triggers a Worker call.
 *
 * **Fitness** scales v_flat and vam by the *same* factor. Because every cost is
 * `dist/v_flat + ascent/vam`, scaling both by f divides every time by f -- the
 * optimum path is unchanged, only the absolute times move. So Fitness is applied
 * **purely client-side** by rescaling the received times and the colour-band
 * boundaries; it MUST NOT trigger a Worker call or re-route. See {@link applyFitness}.
 *
 * Accuracy note (accepted for v1): real fitness improves VAM more than flat speed,
 * so scaling both equally is a simplification -- but it makes the Fitness slider
 * free and instant, which is the point.
 */

/** A rider profile in the units the Worker API expects: metres per second. */
export interface Speeds {
  /** Flat speed, m/s. */
  readonly vFlatMps: number;
  /** Vertical ascent speed (VAM), m/s (= Hm/s). */
  readonly vamMps: number;
}

const KMH_TO_MPS = 1000 / 3600;
const HMH_TO_MPS = 1 / 3600;

export function fromKmh(vFlatKmh: number, vamHmh: number): Speeds {
  return { vFlatMps: vFlatKmh * KMH_TO_MPS, vamMps: vamHmh * HMH_TO_MPS };
}

/** The spec's three Profil anchors, from flat-specialist to climber. */
export const PROFILE_ANCHORS: ReadonlyArray<{ label: string; kmh: number; hmh: number }> = [
  { label: 'Flach', kmh: 30, hmh: 500 },
  { label: 'Mixed', kmh: 27, hmh: 700 },
  { label: 'Gebirge', kmh: 25, hmh: 900 },
];

/**
 * Map the Profil slider (0 = Flach .. 1 = Gebirge) to speeds by piecewise-linear
 * interpolation across the three anchors. A continuous slider feels better than
 * three notches while still passing through the named presets.
 */
export function profileToSpeeds(t: number): Speeds {
  const clamped = Math.min(1, Math.max(0, t));
  const span = clamped * (PROFILE_ANCHORS.length - 1); // 0..2
  const i = Math.min(PROFILE_ANCHORS.length - 2, Math.floor(span));
  const frac = span - i;
  const a = PROFILE_ANCHORS[i];
  const b = PROFILE_ANCHORS[i + 1];
  return fromKmh(a.kmh + (b.kmh - a.kmh) * frac, a.hmh + (b.hmh - a.hmh) * frac);
}

/** Fitness multiplier range for the slider (0 = 0.7x, 1 = 1.3x). */
export const FITNESS_MIN = 0.7;
export const FITNESS_MAX = 1.3;

export function fitnessToFactor(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return FITNESS_MIN + (FITNESS_MAX - FITNESS_MIN) * clamped;
}

/**
 * Rescale a Worker-computed time by the Fitness factor -- **client-side only**.
 *
 * A fitter rider (factor > 1) is faster, so their time is smaller: `t / factor`.
 * This is applied to every displayed time and to the band boundaries, never sent
 * to the Worker.
 */
export function applyFitness(timeSeconds: number, factor: number): number {
  return timeSeconds / factor;
}
