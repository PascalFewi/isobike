/**
 * Mirror of `build/geo.py`. The earth radius and the exact form of the distance
 * function are a cross-language contract: the build pipeline bakes `edgeDist`
 * from them, and the A* heuristic here must not disagree with those baked values
 * or admissibility breaks.
 *
 * Determinism: `Math.sin`/`cos`/`asin` are not required to be correctly rounded,
 * so V8 and CPython's libm may differ in the last ulp. That is confined to places
 * where it cannot change an answer -- see the note in `build/geo.py`.
 */

/** IUGG mean earth radius, in metres. Must equal `R_EARTH_M` in geo.py. */
export const R_EARTH_M = 6371008.8;

/** Metres per degree of latitude on that sphere. */
export const M_PER_DEG_LAT = (R_EARTH_M * Math.PI) / 180.0;

const DEG_TO_RAD = Math.PI / 180.0;

/**
 * Great-circle distance in metres.
 *
 * A polyline's summed segment lengths obey the triangle inequality on a sphere,
 * so `edgeDist >= haversineM(endpoints)` always holds -- which is what makes the
 * A* heuristic admissible. `validate_graph` enforces it on the stored data.
 */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const dphi = (lat2 - lat1) * DEG_TO_RAD;
  const dlambda = (lon2 - lon1) * DEG_TO_RAD;
  const sinDphi = Math.sin(dphi * 0.5);
  const sinDlambda = Math.sin(dlambda * 0.5);
  const a = sinDphi * sinDphi + Math.cos(phi1) * Math.cos(phi2) * sinDlambda * sinDlambda;
  return 2.0 * R_EARTH_M * Math.asin(Math.sqrt(Math.min(1.0, a)));
}

/**
 * Metres per degree of longitude at `latRef`.
 *
 * Snapping projects candidates equirectangularly, where the approximation is
 * accurate to well under a millimetre across a few grid cells and costs
 * arithmetic instead of a haversine per candidate. The ring-expansion bound uses
 * the same projection, so the search stays provably correct.
 *
 * **Hoist this out of the candidate loop.** It contains the only transcendental
 * call in snapping; evaluated per candidate it dominated the query, at 132 us
 * against ~1 us for the actual search.
 */
export function lonScaleM(latRef: number): number {
  return M_PER_DEG_LAT * Math.cos(latRef * DEG_TO_RAD);
}

/** Latitude degrees to metres. */
export function latToM(lat: number): number {
  return lat * M_PER_DEG_LAT;
}
