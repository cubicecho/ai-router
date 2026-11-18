import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEV_SECRET,
  dataDir,
  describeWeakSecret,
  envFlag,
  PLACEHOLDER_SECRET,
  ROOT,
  trustProxy,
  usesPostgres,
} from '../../server/core/config.ts';
import { AUTH_DEFAULTS } from '../../server/core/defaults.ts';

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

describe('the database', () => {
  it.each(['postgres://a@b/c', 'postgresql://a@b/c'])('treats %s as Postgres', (url) => {
    expect(usesPostgres(url)).toBe(true);
  });

  it.each(['', 'memory://', '/var/lib/pg'])('treats %j as PGlite', (url) => {
    expect(usesPostgres(url)).toBe(false);
  });

  it('keeps data in the checkout when DATA_DIR is unset', () => {
    vi.stubEnv('DATA_DIR', '');
    expect(dataDir()).toBe(path.join(ROOT, 'data'));
  });

  it('keeps data where DATA_DIR says', () => {
    vi.stubEnv('DATA_DIR', '/data');
    expect(dataDir()).toBe('/data');
  });
});
