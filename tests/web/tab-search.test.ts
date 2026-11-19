import { describe, expect, it } from 'vitest';
import { openTab, tabSearch } from '../../web/lib/tab-search.ts';

const TABS = ['agents', 'keys', 'mcp', 'usage'] as const;

describe('tabSearch', () => {
  const validate = tabSearch(TABS);

  it('keeps a tab the page has', () => {
    expect(validate({ tab: 'keys' })).toEqual({ tab: 'keys' });
  });

  it('drops the default tab, and any the page does not have', () => {
    expect(validate({ tab: 'agents' })).toEqual({ tab: undefined });
    expect(validate({ tab: 'settings' })).toEqual({ tab: undefined });
    expect(validate({})).toEqual({ tab: undefined });
  });

  it('opens the first tab when none is named, or one the page lacks', () => {
    expect(openTab(TABS, TABS, undefined)).toBe('agents');
    expect(openTab(TABS, TABS, 'usage')).toBe('usage');
    expect(openTab(TABS, TABS, 'settings')).toBe('agents');
    expect(openTab(TABS, ['agents', 'keys'], 'usage')).toBe('agents');
  });
});
