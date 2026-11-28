import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEV_SECRET,
  describeWeakSecret,
  envFlag,
  isPostgresUrl,
  mdnsAdvertise,
  mdnsDiscover,
  PLACEHOLDER_SECRET,
  trustProxy,
} from '../../server/core/config.ts';
import { AUTH_DEFAULTS, DISCOVERY_DEFAULTS } from '../../server/core/defaults.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('describeWeakSecret', () => {
  it.each([undefined, ''])('refuses a secret that is not set (%j)', (secret) => {
    expect(describeWeakSecret(secret)).toBe('is not set');
  });

  it.each([DEV_SECRET, PLACEHOLDER_SECRET])('refuses the published default %s', (secret) => {
    expect(describeWeakSecret(secret)).toBe('is a published default');
  });

  it('refuses a secret one character short', () => {
    expect(describeWeakSecret('x'.repeat(AUTH_DEFAULTS.minSecretLength - 1))).toContain('shorter than');
  });

  it('accepts a secret of the minimum length', () => {
    expect(describeWeakSecret('x'.repeat(AUTH_DEFAULTS.minSecretLength))).toBeUndefined();
  });
});

describe('trustProxy', () => {
  it.each([
    ['', false],
    ['false', false],
    ['true', true],
    ['1', 1],
    ['2', 2],
    ['loopback', 'loopback'],
  ])('reads TRUST_PROXY=%j as %j', (value, expected) => {
    vi.stubEnv('TRUST_PROXY', value);
    expect(trustProxy()).toBe(expected);
  });
});

describe('envFlag', () => {
  it.each(['1', 'true', 'YES', ' yes '])('reads %j as on', (value) => {
    expect(envFlag(value, false)).toBe(true);
  });

  it.each(['0', 'off', 'nope'])('reads %j as off', (value) => {
    expect(envFlag(value, true)).toBe(false);
  });

  it.each([undefined, '', '  '])('falls back for %j', (value) => {
    expect(envFlag(value, true)).toBe(true);
  });
});

describe('isPostgresUrl', () => {
  it.each(['postgres://a@b/c', 'postgresql://a@b/c'])('accepts %s', (url) => {
    expect(isPostgresUrl(url)).toBe(true);
  });

  it.each(['', 'memory://', '/var/lib/pg', 'mysql://a@b/c'])('refuses %j', (url) => {
    expect(isPostgresUrl(url)).toBe(false);
  });
});

describe('the mDNS switches', () => {
  it.each([
    ['MDNS_ADVERTISE', mdnsAdvertise, DISCOVERY_DEFAULTS.advertise],
    ['MDNS_DISCOVER', mdnsDiscover, DISCOVERY_DEFAULTS.discover],
  ])('%s follows its default until set', (name, read, fallback) => {
    vi.stubEnv(name, '');
    expect(read()).toBe(fallback);
    vi.stubEnv(name, 'true');
    expect(read()).toBe(true);
    vi.stubEnv(name, 'false');
    expect(read()).toBe(false);
  });
});
