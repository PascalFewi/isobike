/**
 * Rider profile (Profil slider) and flat speed (Geschwindigkeit im Flachen).
 *
 * **Profil** sets the *ratio* v_flat : vam, i.e. how much a rider trades distance
 * for climbing. It changes route choice, so moving it triggers a Worker call.
 *
 * **Flat speed** sets the absolute pace: the rider's v_flat, with vam following
 * at the profile's ratio. That scales v_flat and vam by the *same* factor, and
 * because every cost is `dist/v_flat + ascent/vam`, every time divides by that
 * factor while the optimum path stays the same. So the speed slider is applied
 * **purely client-side** by rescaling the received times and the colour-band
 * boundaries; it MUST NOT trigger a Worker call or re-route. See
 * {@link speedFactor} and {@link displayTime}.
 *
 * Accuracy note (accepted for v1): a faster rider usually gains more on climbs
 * than on the flat, so scaling both equally is a simplification -- but it makes
 * the slider free and instant, which is the point.
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
 * interpolation across the three anchors. These speeds go to the Worker; only
 * their ratio matters for the route.
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

/** Flat speed slider: range and default, km/h. */
export const FLAT_KMH_MIN = 15;
export const FLAT_KMH_MAX = 40;
export const FLAT_KMH_DEFAULT = 25;

/**
 * How much faster the rider is than the profile speeds the Worker routed with:
 * `rider v_flat / profile v_flat`. Times divide by this -- **client-side only**.
 */
export function speedFactor(flatKmh: number, profile: Speeds): number {
  return (flatKmh * KMH_TO_MPS) / profile.vFlatMps;
}

/** The rider's VAM at this flat speed and profile ratio, Hm/h -- for display. */
export function riderVamHmh(flatKmh: number, profile: Speeds): number {
  return (profile.vamMps * speedFactor(flatKmh, profile)) / HMH_TO_MPS;
}

/** A Worker time (at profile speeds) as the rider's time: `t / factor`. */
export function displayTime(workerSeconds: number, factor: number): number {
  return workerSeconds / factor;
}
