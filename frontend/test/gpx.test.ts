import { describe, expect, it } from 'vitest';

import { stripTags } from '../src/lib/geocode.ts';
import { buildGpx, cumulativeDistance, haversineM, type Coord } from '../src/lib/gpx.ts';

const ROUTE: Coord[] = [[7.6297, 46.7548, 560.2], [7.64, 46.75, 571.0], [7.66, 46.74, 598.5]];

describe('GPX export', () => {
  const gpx = buildGpx('Thun – Oberhofen & co', ROUTE, [{ lat: 46.7548, lon: 7.6297, name: 'A Thun' }]);

  it('is GPX 1.1 with one track point per vertex, elevation included', () => {
    expect(gpx).toContain('<gpx version="1.1"');
    expect(gpx.match(/<trkpt /g)?.length).toBe(ROUTE.length);
    expect(gpx).toContain('<trkpt lat="46.754800" lon="7.629700"><ele>560.2</ele></trkpt>');
  });

  it('escapes names and writes waypoints', () => {
    expect(gpx).toContain('Thun – Oberhofen &amp; co');
    expect(gpx).toContain('<wpt lat="46.754800" lon="7.629700"><name>A Thun</name></wpt>');
  });
});

describe('cumulative distance', () => {
  it('sums haversine legs from zero', () => {
    const d = cumulativeDistance(ROUTE);
    expect(d[0]).toBe(0);
    expect(d[2]).toBeCloseTo(haversineM(46.7548, 7.6297, 46.75, 7.64) + haversineM(46.75, 7.64, 46.74, 7.66), 6);
  });

  it('measures one degree of latitude as ~111 km', () => {
    expect(haversineM(46, 7, 47, 7) / 1000).toBeCloseTo(111.2, 0);
  });
});

describe('search labels', () => {
  it('strips the HTML swisstopo puts in labels', () => {
    expect(stripTags('<i>Ort</i> <b>Grindelwald</b> (BE) - Grindelwald')).toBe('Ort Grindelwald (BE) - Grindelwald');
  });
});
