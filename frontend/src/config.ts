/**
 * Deployment-specific endpoints and defaults. Filled in per environment via Vite
 * env vars (`.env`), with dev-friendly fallbacks. Nothing here is secret -- the
 * Worker API and the tiles are public, read-only.
 */

/**
 * A path like `/api` means "on the same host as the page" -- the self-hosted
 * deployment serves frontend, API and tiles from one origin, so the build works
 * unchanged on the bare IP now and on the domain later. Absolute URLs (local
 * dev, a separate Worker) pass through.
 */
function resolve(url: string): string {
  return url.startsWith('/') && typeof window !== 'undefined' ? `${window.location.origin}${url}` : url;
}

/** Routing API base: `/api` in production, http://localhost:8787 in dev. */
export const WORKER_URL: string = resolve(import.meta.env.VITE_WORKER_URL ?? 'http://localhost:8787');

/** PMTiles archive: `/data/network.pmtiles` in production. */
export const PMTILES_URL: string = resolve(
  import.meta.env.VITE_PMTILES_URL ?? 'http://localhost:8788/network.pmtiles',
);

/** The PMTiles source layer name tippecanoe was told to write (`-l network`). */
export const TILE_LAYER = 'network';

/** Initial map view -- centred on Switzerland. */
export const INITIAL_VIEW = { lon: 8.23, lat: 46.8, zoom: 8 } as const;

/** Reference latitude for the 200 m real-width line calculation (mid-Switzerland). */
export const REFERENCE_LAT = 46.8;

/** Effort-field time budget requested from the worker, in seconds (8 h). */
export const DEFAULT_BUDGET_S = 8 * 3600;
