import { describe, expect, it } from 'vitest';
import { costOf, formatCost, priceBookFrom } from '../../web/models/cost.ts';

const BOOK = priceBookFrom({
  modelPrices: [{ providerId: 'openai', model: 'gpt-5', inputPerMillion: 1, outputPerMillion: 10 }],
  pools: [
    { id: 'priced', inputPricePerMillion: 0.5, outputPricePerMillion: 2 },
    { id: 'unpriced', inputPricePerMillion: null, outputPricePerMillion: null },
  ],
});
const ROW = { providerId: 'openai', model: 'gpt-5', inputTokens: 2_000_000, outputTokens: 500_000 };

describe('costOf', () => {
  it("costs a direct call at its provider's model price", () => {
    expect(costOf(ROW, BOOK)).toBe(7);
  });

  it("costs a call through a priced pool at the pool's price, whatever served it", () => {
    expect(costOf({ ...ROW, poolId: 'priced' }, BOOK)).toBe(2);
  });

  it("falls back to the target's price for a pool with none", () => {
    expect(costOf({ ...ROW, poolId: 'unpriced' }, BOOK)).toBe(7);
  });

  it('has no cost for a model nobody priced, or one whose provider is gone', () => {
    expect(costOf({ ...ROW, model: 'gpt-4' }, BOOK)).toBeNull();
    expect(costOf({ ...ROW, providerId: null }, BOOK)).toBeNull();
  });
});

describe('formatCost', () => {
  it('writes two places, more for a fraction of a cent, and marks a floor', () => {
    expect(formatCost(7, false)).toBe((7).toLocaleString(undefined, { minimumFractionDigits: 2 }));
    expect(formatCost(0.0042, false)).toContain('42');
    expect(formatCost(7, true).startsWith('≥ ')).toBe(true);
    expect(formatCost(null, true)).toBe('–');
  });
});
