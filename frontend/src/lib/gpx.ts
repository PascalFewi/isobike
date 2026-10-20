/**
 * GPX 1.1 export of a route polyline with elevations, plus the along-route
 * distance helpers the elevation chart shares.
 */

export type Coord = readonly [number, number, number]; // lon, lat, elevation_m

const R_EARTH_M = 6371008.8;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** Cumulative distance in metres at each vertex (0 at the first). */
export function cumulativeDistance(coords: readonly Coord[]): Float64Array {
  const out = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) {
    const [lonA, latA] = coords[i - 1];
    const [lonB, latB] = coords[i];
    out[i] = out[i - 1] + haversineM(latA, lonA, latB, lonB);
  }
  return out;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export interface GpxWaypoint {
  readonly lat: number;
  readonly lon: number;
  readonly name: string;
}

/** A GPX 1.1 document: the waypoints as `<wpt>`, the polyline as one `<trk>`. */
export function buildGpx(name: string, coords: readonly Coord[], waypoints: readonly GpxWaypoint[] = []): string {
  const wpts = waypoints
    .map((w) => `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}"><name>${escapeXml(w.name)}</name></wpt>`)
    .join('\n');
  const pts = coords
    .map(([lon, lat, ele]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${ele.toFixed(1)}</ele></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="VeloRouter" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escapeXml(name)}</name></metadata>
${wpts ? wpts + '\n' : ''}  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

/** Trigger a browser download of a text file. */
export function downloadText(filename: string, text: string, mime = 'application/gpx+xml'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
