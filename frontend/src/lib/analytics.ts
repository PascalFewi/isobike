/**
 * Usage statistics via a self-hosted Umami (deploy/README.md): page views plus
 * the few events below. No cookies. Off unless the deployment sets
 * `VITE_UMAMI_WEBSITE_ID` and `VITE_UMAMI_SCRIPT_URL`, so local development and
 * forks send nothing.
 *
 * Events carry counts and choices only -- never coordinates, place names or
 * routes. What is collected is described to visitors in PrivacyDialog.tsx;
 * change the two together.
 */

/** Every event the app sends, with its data. */
export interface AnalyticsEvents {
  /** A waypoint was added; `n` is its position (1 = the start). */
  'point-add': { via: 'map' | 'search'; n: number };
  /** "GPX exportieren" opened the export dialog. */
  'export-open': { points: number };
  /** The GPX file was downloaded. */
  'gpx-download': { points: number; km: number; bike: string };
  'round-trip': { points: number };
}

interface Umami {
  track(event: string, data?: Record<string, string | number>): void;
}

declare global {
  interface Window {
    umami?: Umami;
  }
}

/** Adds the Umami script to the page, once, if the deployment configured it. */
export function loadAnalytics(): void {
  const id = import.meta.env.VITE_UMAMI_WEBSITE_ID;
  const src = import.meta.env.VITE_UMAMI_SCRIPT_URL;
  if (!id || !src) return;
  const s = document.createElement('script');
  s.defer = true;
  s.src = src;
  s.dataset.websiteId = id;
  // Only count on the real site, not on previews or copies of the build.
  const domains = import.meta.env.VITE_UMAMI_DOMAINS;
  if (domains) s.dataset.domains = domains;
  // Visitors whose browser sends "Do Not Track" are not counted.
  s.dataset.doNotTrack = 'true';
  document.head.append(s);
}

/** Records an event. Does nothing without Umami (not configured, blocked, still loading). */
export function track<K extends keyof AnalyticsEvents>(event: K, data: AnalyticsEvents[K]): void {
  try {
    window.umami?.track(event, data);
  } catch {
    // Statistics must never break the app.
  }
}
