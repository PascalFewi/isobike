/**
 * Deployment-specific endpoints and defaults. Filled in per environment via Vite
 * env vars (`.env`), with dev-friendly fallbacks. Nothing here is secret -- the
 * Worker API and the tiles are public, read-only.
 */

/** Worker API base, e.g. https://velorouter-worker.<subdomain>.workers.dev */
export const WORKER_URL: string =
  import.meta.env.VITE_WORKER_URL ?? 'http://localhost:8787';

/** PMTiles archive on R2/CDN, e.g. https://<r2-public>/network.pmtiles */
export const PMTILES_URL: string =
  import.meta.env.VITE_PMTILES_URL ?? 'http://localhost:8787/network.pmtiles';

/** The PMTiles source layer name tippecanoe was told to write (`-l network`). */
export const TILE_LAYER = 'network';

/** Initial map view -- centred on Switzerland. */
export const INITIAL_VIEW = { lon: 8.23, lat: 46.8, zoom: 8 } as const;

/** Reference latitude for the 200 m real-width line calculation (mid-Switzerland). */
export const REFERENCE_LAT = 46.8;

/** Effort-field time budget requested from the worker, in seconds (8 h). */
export const DEFAULT_BUDGET_S = 8 * 3600;
