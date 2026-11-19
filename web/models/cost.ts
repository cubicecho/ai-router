/** Tokens a price is given per. */
const TOKENS_PER_PRICE = 1_000_000;

/** What a model or pool costs per million tokens, in whatever currency its prices are entered in. */
export interface Price {
  inputPerMillion: number;
  outputPerMillion: number;
}

/** Every price people have entered, looked up by what a usage row names. */
export interface PriceBook {
  /** A pool's own price, by the pool's id. */
  byPool: ReadonlyMap<string, Price>;
  /** A provider's model's price, by `priceKey`. */
  byModel: ReadonlyMap<string, Price>;
}

/** The part of a usage row its cost is worked out from. */
export interface CostedRow {
  poolId?: string | null;
  providerId?: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** What the price book is read from: the model prices, and each pool with its own. */
export interface PriceSource {
  modelPrices: readonly ({ providerId: string; model: string } & Price)[];
  pools: readonly { id: string; inputPricePerMillion?: number | null; outputPricePerMillion?: number | null }[];
}

/**
 * Names a provider's model in the price book.
 *
 * @param providerId - The provider.
 * @param model - The model's id there.
 * @returns The key.
 */
function priceKey(providerId: string, model: string): string {
  return `${providerId}\n${model}`;
}

/**
 * Builds the price book.
 *
 * @param source - The prices, as the API answers them.
 * @returns The book. A pool with no price of its own is not in it.
 */
export function priceBookFrom(source: PriceSource): PriceBook {
  const byPool = new Map<string, Price>();
  for (const pool of source.pools) {
    const { inputPricePerMillion, outputPricePerMillion } = pool;
    const isPriced = typeof inputPricePerMillion === 'number' && typeof outputPricePerMillion === 'number';
    if (isPriced) {
      byPool.set(pool.id, { inputPerMillion: inputPricePerMillion, outputPerMillion: outputPricePerMillion });
    }
  }
  const byModel = new Map(
    source.modelPrices.map((price) => [
      priceKey(price.providerId, price.model),
      { inputPerMillion: price.inputPerMillion, outputPerMillion: price.outputPerMillion },
    ]),
  );
  return { byPool, byModel };
}

/**
 * Works out what a usage row cost, at the prices entered now.
 *
 * @param row - The row.
 * @param book - The prices.
 * @returns The cost; null when neither its pool nor its provider's model has a price, or what it named is gone.
 *
 * @remarks
 * A call through a pool with its own price costs the pool's price, whatever target served it. Otherwise it costs
 * the price of the provider's model it went to.
 */
export function costOf(row: CostedRow, book: PriceBook): number | null {
  const poolPrice = row.poolId ? book.byPool.get(row.poolId) : undefined;
  const modelPrice = row.providerId ? book.byModel.get(priceKey(row.providerId, row.model)) : undefined;
  const price = poolPrice ?? modelPrice;
  if (price === undefined) {
    return null;
  }
  return (row.inputTokens * price.inputPerMillion + row.outputTokens * price.outputPerMillion) / TOKENS_PER_PRICE;
}

/** How a cost is written: to two places. */
const TWO_PLACES = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** How a cost too small for two places is written: to two significant digits, so it doesn't read as nothing. */
const SMALL = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 2 });
/** The smallest cost two places show. */
const SMALLEST_AT_TWO_PLACES = 0.01;

/**
 * Writes a cost for a table cell.
 *
 * @param cost - The cost of the priced rows.
 * @param hasUnpriced - Whether some of the rows have no price, so the real cost is higher.
 * @returns The cost, marked as at least that when some rows are unpriced; a dash when none is priced.
 */
export function formatCost(cost: number | null, hasUnpriced: boolean): string {
  if (cost === null) {
    return '–';
  }
  const isTiny = cost > 0 && cost < SMALLEST_AT_TWO_PLACES;
  const written = isTiny ? SMALL.format(cost) : TWO_PLACES.format(cost);
  return hasUnpriced ? `≥ ${written}` : written;
}
