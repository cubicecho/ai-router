import { describe, expect, it } from 'vitest';
import { serverTabsOf, validateServerSearch } from '../../web/tools/server-tabs.ts';

describe('serverTabsOf', () => {
  it('gives a remote server with a login every tab', () => {
    expect(serverTabsOf({ isBuiltin: false, hasLogin: true })).toEqual([
      'overview',
      'tools',
      'instances',
      'secrets',
      'login',
      'activity',
    ]);
  });

  it('gives a server the router starts no Login', () => {
    expect(serverTabsOf({ isBuiltin: false, hasLogin: false })).toEqual([
      'overview',
      'tools',
      'instances',
      'secrets',
      'activity',
    ]);
  });

  it('gives the admin server neither Secrets nor Login', () => {
    expect(serverTabsOf({ isBuiltin: true, hasLogin: false })).toEqual(['overview', 'tools', 'instances', 'activity']);
  });
});

describe('validateServerSearch', () => {
  it('keeps a tab only some servers have, for the page to fall back from', () => {
    expect(validateServerSearch({ tab: 'login' })).toEqual({ tab: 'login' });
    expect(validateServerSearch({ tab: 'keys' })).toEqual({ tab: undefined });
  });
});
