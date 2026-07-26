/**
 * Profil / Fitness math -- especially the invariant that makes Fitness free:
 * scaling both speeds by the same factor rescales every time uniformly and does
 * NOT change route choice.
 */

import { describe, expect, it } from 'vitest';

import {
  PROFILE_ANCHORS,
  applyFitness,
  fitnessToFactor,
  fromKmh,
  profileToSpeeds,
} from '../src/lib/profile.ts';

describe('profileToSpeeds', () => {
  it('hits the named anchors at 0, 0.5, 1', () => {
    expect(profileToSpeeds(0)).toEqual(fromKmh(30, 500)); // Flach
    expect(profileToSpeeds(0.5)).toEqual(fromKmh(27, 700)); // Mixed
    expect(profileToSpeeds(1)).toEqual(fromKmh(25, 900)); // Gebirge
  });

  it('interpolates continuously between anchors', () => {
    const q = profileToSpeeds(0.25); // halfway Flach->Mixed
    expect(q.vFlatMps).toBeCloseTo(fromKmh(28.5, 600).vFlatMps, 9);
    expect(q.vamMps).toBeCloseTo(fromKmh(28.5, 600).vamMps, 9);
  });

  it('clamps out-of-range sliders', () => {
    expect(profileToSpeeds(-1)).toEqual(profileToSpeeds(0));
    expect(profileToSpeeds(2)).toEqual(profileToSpeeds(1));
  });

  it('converts km/h and Hm/h to m/s', () => {
    const s = fromKmh(27, 700);
    expect(s.vFlatMps).toBeCloseTo(7.5, 9);
    expect(s.vamMps).toBeCloseTo(700 / 3600, 9);
  });

  it('the climber profile has a lower cf (v_flat/vam) than the flat specialist', () => {
    const flach = profileToSpeeds(0);
    const gebirge = profileToSpeeds(1);
    expect(flach.vFlatMps / flach.vamMps).toBeGreaterThan(gebirge.vFlatMps / gebirge.vamMps);
  });

  it('exposes the three spec anchors', () => {
    expect(PROFILE_ANCHORS.map((a) => a.label)).toEqual(['Flach', 'Mixed', 'Gebirge']);
  });
});

describe('fitness is a pure time rescale, not a re-route', () => {
  it('maps the slider onto 0.7x..1.3x', () => {
    expect(fitnessToFactor(0)).toBeCloseTo(0.7, 9);
    expect(fitnessToFactor(0.5)).toBeCloseTo(1.0, 9);
    expect(fitnessToFactor(1)).toBeCloseTo(1.3, 9);
  });

  it('a fitter rider sees smaller times (t / factor)', () => {
    expect(applyFitness(3600, 1.3)).toBeCloseTo(3600 / 1.3, 6);
    expect(applyFitness(3600, 0.7)).toBeCloseTo(3600 / 0.7, 6);
    expect(applyFitness(3600, 1.0)).toBe(3600);
  });

  it('preserves the ORDER of edge times -- so the route/isochrone shape is unchanged', () => {
    // The property that lets Fitness be applied client-side with no re-route:
    // dividing every time by a positive factor is monotonic.
    const times = [120, 3600, 60, 7200, 1800];
    const factor = 1.15;
    const rescaled = times.map((t) => applyFitness(t, factor));
    const orderBefore = [...times.keys()].sort((a, b) => times[a] - times[b]);
    const orderAfter = [...rescaled.keys()].sort((a, b) => rescaled[a] - rescaled[b]);
    expect(orderAfter).toEqual(orderBefore);
  });
});
