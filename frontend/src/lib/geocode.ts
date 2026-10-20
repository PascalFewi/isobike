/**
 * Place search and naming via the free swisstopo geo.admin.ch API (no key, CORS
 * open). Whatever the rider types into a waypoint field is sent there.
 *
 *   search: SearchServer, type=locations -- towns, addresses, mountains, stations
 *   name:   MapServer identify on the municipality layer -- "Thun" for a click
 */

const API = 'https://api3.geo.admin.ch/rest/services/api';

export interface Place {
  readonly label: string;
  readonly lat: number;
  readonly lon: number;
}

/** "<i>Ort</i> <b>Grindelwald</b> (BE)" -> "Ort Grindelwald (BE)" */
export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

export async function searchPlaces(text: string, signal?: AbortSignal): Promise<Place[]> {
  const q = text.trim();
  if (q.length < 2) return [];
  const url = `${API}/SearchServer?type=locations&sr=4326&limit=6&searchText=${encodeURIComponent(q)}`;
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`Ortssuche fehlgeschlagen (${res.status})`);
  const json = (await res.json()) as { results?: Array<{ attrs: { label: string; lat: number; lon: number } }> };
  return (json.results ?? []).map((r) => ({ label: stripTags(r.attrs.label), lat: r.attrs.lat, lon: r.attrs.lon }));
}

/** Municipality name at a point, or null outside Switzerland / on failure. */
export async function municipalityAt(lat: number, lon: number): Promise<string | null> {
  const url =
    `${API}/MapServer/identify?geometry=${lon},${lat}&geometryType=esriGeometryPoint` +
    '&layers=all:ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill&sr=4326&tolerance=0&returnGeometry=false';
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      results?: Array<{ attributes: { gemname?: string; is_current_jahr?: boolean } }>;
    };
    const results = json.results ?? [];
    const current = results.find((r) => r.attributes.is_current_jahr) ?? results[0];
    return current?.attributes.gemname ?? null;
  } catch {
    return null;
  }
}

/** "46.9480, 7.4474" -- fallback label for a clicked point. */
export function coordLabel(lat: number, lon: number): string {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}
