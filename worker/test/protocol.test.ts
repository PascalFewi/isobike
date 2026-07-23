/**
 * Wire-protocol tests: the effort-field binary round-trip (tied to the golden
 * field so the serialized bytes carry the cross-language-verified values), and
 * every request-parsing / cost-model path including the failure modes.
 */

import { describe, expect, it } from 'vitest';

import { timeModel } from '../src/router.js';
import { effortField } from '../src/router.js';
import {
  ApiError,
  DEFAULT_BUDGET_S,
  EFFORT_HEADER_SIZE,
  EFFORT_MAGIC,
  alphaToClimbFactor,
  parseEffortFieldBody,
  parseEffortFieldResponse,
  parseRouteBody,
  parseSnapQuery,
  resolveCostModel,
  resolveMetric,
  serializeEffortField,
} from '../src/protocol.js';
import { loadExpected, loadRidgeWorld, toBudget, toCostModel, toSlopeLimit } from './fixtures.js';

const graph = loadRidgeWorld();
const expected = loadExpected();

// --------------------------------------------------------------------------- //
// Effort-field binary response
// --------------------------------------------------------------------------- //

describe('effort-field serialization', () => {
  it('round-trips the golden field, values intact to f32', () => {
    // Reproduce every golden effort_field config through the serializer, so the
    // wire bytes are anchored to the cross-language-verified answers.
    for (const want of expected.effort_fields) {
      const field = effortField(graph, want.source, toCostModel(want.model), {
        maxSlopePct: toSlopeLimit(want.max_slope_pct),
        maxCost: toBudget(want.max_cost_s),
      });
      const buffer = serializeEffortField(graph, want.source, field);
      const parsed = parseEffortFieldResponse(buffer);

      expect(parsed.count).toBe(want.edge_count);
      expect(parsed.snappedNode).toBe(want.source);
      expect(parsed.snappedLat).toBe(graph.nodeLat[want.source]);
      expect(parsed.snappedLon).toBe(graph.nodeLon[want.source]);

      // Entries come out in ascending edge_id order.
      const ids = [...parsed.edgeIds];
      expect(ids).toEqual([...ids].sort((a, b) => a - b));

      // Each (time, cum_ascent) equals the golden value rounded to f32.
      const byId = new Map<number, number>();
      parsed.edgeIds.forEach((id, i) => byId.set(id, i));
      let maxTime = 0;
      let maxCum = 0;
      for (const [edgeId, time, cumAscent] of want.entries) {
        const i = byId.get(edgeId);
        expect(i, `edge ${edgeId} present`).not.toBeUndefined();
        expect(parsed.times[i!]).toBe(Math.fround(time));
        expect(parsed.cumAscents[i!]).toBe(Math.fround(cumAscent));
        maxTime = Math.max(maxTime, time);
        maxCum = Math.max(maxCum, cumAscent);
      }
      expect(parsed.maxTime).toBe(Math.fround(maxTime));
      expect(parsed.maxCumAscent).toBe(Math.fround(maxCum));
    }
  });

  it('lays out a valid, correctly sized buffer', () => {
    const want = expected.effort_fields[0];
    const field = effortField(graph, want.source, toCostModel(want.model), {
      maxSlopePct: toSlopeLimit(want.max_slope_pct),
      maxCost: toBudget(want.max_cost_s),
    });
    const buffer = serializeEffortField(graph, want.source, field);

    expect(buffer.byteLength).toBe(EFFORT_HEADER_SIZE + 12 * field.count);
    const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
    expect(magic).toBe(EFFORT_MAGIC);
    // SoA sections are 4-aligned so the parser's typed-array views are legal.
    const parsed = parseEffortFieldResponse(buffer);
    expect(parsed.edgeIds.byteOffset % 4).toBe(0);
    expect(parsed.times.byteOffset % 4).toBe(0);
    expect(parsed.cumAscents.byteOffset % 4).toBe(0);
  });

  it('serializes an empty field (unreachable source component) without a payload', () => {
    // The island source reaches only its two neighbours' edges; force emptiness
    // with a budget of essentially zero so only zero-cost source edges survive...
    // simplest: a source whose whole field is filtered out by a 0 budget.
    const field = effortField(graph, 0, timeModel(7.5, 0.19), { maxCost: -1 });
    const buffer = serializeEffortField(graph, 0, field);
    const parsed = parseEffortFieldResponse(buffer);
    expect(parsed.count).toBe(0);
    expect(parsed.edgeIds.length).toBe(0);
    expect(parsed.maxTime).toBe(0);
  });

  it('rejects a corrupt response', () => {
    const buffer = serializeEffortField(
      graph,
      0,
      effortField(graph, 0, timeModel(7.5, 0.19)),
    );
    const bad = buffer.slice(0);
    new Uint8Array(bad)[0] ^= 0xff;
    expect(() => parseEffortFieldResponse(bad)).toThrow(/magic/);
    expect(() => parseEffortFieldResponse(buffer.slice(0, 10))).toThrow(ApiError);
  });
});

// --------------------------------------------------------------------------- //
// Cost-model resolution
// --------------------------------------------------------------------------- //

describe('cost-model resolution', () => {
  it('builds the time model from v_flat and vam (m/s)', () => {
    const model = resolveCostModel({ v_flat: 7.5, vam: 0.19 });
    expect(model).toEqual(timeModel(7.5, 0.19));
    expect(model.a).toBe(1 / 7.5);
    expect(model.b).toBe(1 / 0.19);
  });

  it('falls back to distance-equivalent from alpha', () => {
    const model = resolveCostModel({ alpha: 0.5 });
    expect(model.a).toBe(1);
    expect(model.b).toBe(alphaToClimbFactor(0.5)); // cf = 8
  });

  it('prefers a profile over alpha when both are present', () => {
    const model = resolveCostModel({ v_flat: 7, vam: 0.2, alpha: 0.9 });
    expect(model).toEqual(timeModel(7, 0.2));
  });

  it.each([
    [{}, /v_flat and vam/],
    [{ v_flat: 7.5 }, /together/],
    [{ vam: 0.19 }, /together/],
    [{ v_flat: 0, vam: 0.19 }, /positive/],
    [{ v_flat: 7.5, vam: -1 }, /positive/],
  ])('rejects %o', (body, pattern) => {
    expect(() => resolveCostModel(body)).toThrow(pattern);
  });

  it('rejects an unknown metric but keeps the seam for the default', () => {
    expect(resolveMetric(undefined)).toBe('time');
    expect(resolveMetric('time')).toBe('time');
    expect(() => resolveMetric('minimax')).toThrow(/metric/);
    expect(() => resolveCostModel({ v_flat: 7, vam: 0.2, metric: 'bogus' })).toThrow(/metric/);
  });
});

describe('alpha -> climb_factor fallback', () => {
  it.each([
    [0, 0],
    [0.5, 8],
    [0.9, 72],
    [1, 200],
    [2, 200],
  ])('maps alpha %f to cf %f', (alpha, cf) => {
    expect(alphaToClimbFactor(alpha)).toBeCloseTo(cf, 6);
  });

  it('is capped and monotonic', () => {
    expect(alphaToClimbFactor(0.999)).toBe(200);
    expect(alphaToClimbFactor(0.3)).toBeLessThan(alphaToClimbFactor(0.6));
  });

  it('rejects negative alpha', () => {
    expect(() => alphaToClimbFactor(-0.1)).toThrow(ApiError);
  });
});

// --------------------------------------------------------------------------- //
// Request parsing
// --------------------------------------------------------------------------- //

describe('parseEffortFieldBody', () => {
  it('parses a full request', () => {
    const req = parseEffortFieldBody({
      lat: 46.5,
      lon: 8.03,
      v_flat: 7.5,
      vam: 0.19,
      max_slope: 10,
      max_cost: 3600,
    });
    expect(req.lat).toBe(46.5);
    expect(req.lon).toBe(8.03);
    expect(req.maxSlopePct).toBe(10);
    expect(req.maxCost).toBe(3600);
  });

  it('defaults the budget to 8 hours and leaves slope unset', () => {
    const req = parseEffortFieldBody({ lat: 46.5, lon: 8.03, v_flat: 7.5, vam: 0.19 });
    expect(req.maxCost).toBe(DEFAULT_BUDGET_S);
    expect(req.maxSlopePct).toBeUndefined();
  });

  it.each([
    [{ lon: 8, v_flat: 7, vam: 0.2 }, /lat/],
    [{ lat: 46.5, lon: 8, v_flat: 7, vam: 0.2, max_slope: -1 }, /max_slope/],
    [{ lat: 46.5, lon: 8, v_flat: 7, vam: 0.2, max_cost: 0 }, /max_cost/],
    [{ lat: 200, lon: 8, v_flat: 7, vam: 0.2 }, /range/],
    [{ lat: 46.5, lon: 8, v_flat: 'x', vam: 0.2 }, /v_flat/],
  ])('rejects %o', (body, pattern) => {
    expect(() => parseEffortFieldBody(body)).toThrow(pattern);
  });

  it('rejects a non-object body', () => {
    expect(() => parseEffortFieldBody(null)).toThrow(ApiError);
    expect(() => parseEffortFieldBody([1, 2])).toThrow(ApiError);
  });
});

describe('parseRouteBody', () => {
  it('parses object and array coordinate forms', () => {
    const a = parseRouteBody({ from: { lat: 46.5, lon: 8.0 }, to: { lat: 46.52, lon: 8.06 }, v_flat: 7, vam: 0.2 });
    expect(a.from).toEqual([46.5, 8.0]);
    expect(a.to).toEqual([46.52, 8.06]);

    const b = parseRouteBody({ from: [46.5, 8.0], to: [46.52, 8.06], alpha: 0.5 });
    expect(b.from).toEqual([46.5, 8.0]);
    expect(b.model.a).toBe(1); // alpha fallback
  });

  it.each([
    [{ to: [1, 2], v_flat: 7, vam: 0.2 }, /from and to/],
    [{ from: [1, 2], v_flat: 7, vam: 0.2 }, /from and to/],
    [{ from: [1], to: [1, 2], v_flat: 7, vam: 0.2 }, /lat/],
  ])('rejects %o', (body, pattern) => {
    expect(() => parseRouteBody(body)).toThrow(pattern);
  });
});

describe('parseSnapQuery', () => {
  it('reads lat/lon from the query string', () => {
    const q = parseSnapQuery(new URL('https://x/snap?lat=46.5&lon=8.03'));
    expect(q).toEqual({ lat: 46.5, lon: 8.03 });
  });

  it.each([
    ['https://x/snap?lat=46.5', /lat and lon/],
    ['https://x/snap?lat=x&lon=8', /numbers/],
    ['https://x/snap?lat=200&lon=8', /range/],
  ])('rejects %s', (url, pattern) => {
    expect(() => parseSnapQuery(new URL(url))).toThrow(pattern);
  });
});
