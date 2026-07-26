/**
 * Real-world line width for the effort edges.
 *
 * The spec wants edges drawn ~200 m wide on the ground with round caps, so at low
 * zoom they merge into areas (the Mittelland) but stay corridor-shaped in valleys
 * -- "wirkt wie 100-m-Buffer". That means the pixel width must track zoom, with a
 * floor (~2 px) so a single edge never vanishes.
 */

/** Web-Mercator ground resolution: metres per pixel at a zoom and latitude. */
export function metersPerPixel(zoom: number, lat: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/** Pixel width for a real-world width, floored so an edge stays visible. */
export function realWidthPx(
  meters: number,
  zoom: number,
  lat: number,
  minPx = 2,
): number {
  return Math.max(minPx, meters / metersPerPixel(zoom, lat));
}

/**
 * MapLibre `line-width` interpolation stops for a fixed real width at a reference
 * latitude. Returned as `[zoom, px]` pairs to feed an `interpolate(exponential,
 * 2, zoom, ...)` expression -- exponential base 2 because ground resolution
 * halves per zoom level, so the pixel width doubles.
 */
export function widthStops(
  meters: number,
  lat: number,
  zooms: readonly number[] = [6, 8, 10, 12, 14, 16],
  minPx = 2,
): Array<[number, number]> {
  return zooms.map((z) => [z, realWidthPx(meters, z, lat, minPx)]);
}
