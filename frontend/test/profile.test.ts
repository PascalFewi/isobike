/**
 * Profil / flat-speed math -- especially the invariant that makes the speed slider free:
 * scaling both speeds by the same factor rescales every time uniformly and does
 * NOT change route choice.
 */

import { describe, expect, it } from 'vitest';

import {
  FLAT_KMH_DEFAULT,
  PROFILE_ANCHORS,
  displayTime,
  fromKmh,
  profileToSpeeds,
  riderVamHmh,
  speedFactor,
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

describe('flat speed is a pure time rescale, not a re-route', () => {
  it('is 1 at the profile speed and scales linearly', () => {
    const mixed = profileToSpeeds(0.5); // 27 km/h
    expect(speedFactor(27, mixed)).toBeCloseTo(1, 9);
    expect(speedFactor(25, mixed)).toBeCloseTo(25 / 27, 9);
  });

  it('keeps the profile ratio: VAM scales with the flat speed', () => {
    const mixed = profileToSpeeds(0.5);
    expect(riderVamHmh(27, mixed)).toBeCloseTo(700, 6);
    expect(riderVamHmh(25, mixed)).toBeCloseTo((700 * 25) / 27, 6);
  });

  it('divides times by the factor', () => {
    expect(displayTime(3600, 1.25)).toBeCloseTo(2880, 6);
    expect(displayTime(3600, 1)).toBe(3600);
  });

  it('preserves the ORDER of edge times -- so the route/isochrone shape is unchanged', () => {
    const times = [120, 3600, 60, 7200, 1800];
    const rescaled = times.map((t) => displayTime(t, 0.9));
    const orderBefore = [...times.keys()].sort((a, b) => times[a] - times[b]);
    const orderAfter = [...rescaled.keys()].sort((a, b) => rescaled[a] - rescaled[b]);
    expect(orderAfter).toEqual(orderBefore);
  });

  it('defaults to 25 km/h', () => {
    expect(FLAT_KMH_DEFAULT).toBe(25);
  });
});
