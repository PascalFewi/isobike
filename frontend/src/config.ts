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

/**
 * Basemap: a MapLibre style URL. OpenFreeMap's Positron (light grey, Europe-wide,
 * free, no key) for now; a self-hosted Protomaps style later.
 */
export const BASEMAP_STYLE_URL: string = resolve(
  import.meta.env.VITE_BASEMAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/positron',
);

/** Bike network with road class and surface (build/export.py): `/data/network.pmtiles` in production. */
export const NETWORK_URL: string = resolve(
  import.meta.env.VITE_PMTILES_URL ?? 'http://localhost:8788/network.pmtiles',
);

/** Source layer of the network tiles (`-l network`). */
export const NETWORK_TILE_LAYER = 'network';

/** Cycling POIs (build/pois.py): `/data/pois.pmtiles` in production. */
export const POIS_URL: string = resolve(import.meta.env.VITE_POIS_URL ?? 'http://localhost:8788/pois.pmtiles');

/** Source layer of the POI tiles (`-l pois`). */
export const POI_TILE_LAYER = 'pois';

/** Initial map view -- centred on Switzerland. */
export const INITIAL_VIEW = { lon: 8.23, lat: 46.8, zoom: 8 } as const;

/** Reference latitude for the 200 m real-width line calculation (mid-Switzerland). */
export const REFERENCE_LAT = 46.8;

/** Effort-field time budget requested from the worker, in seconds (8 h). */
export const DEFAULT_BUDGET_S = 8 * 3600;
