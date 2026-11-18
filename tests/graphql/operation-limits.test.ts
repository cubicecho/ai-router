import { type GraphQLSchema, parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATION_LIMIT_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { createSchema } from '../../server/graphql/build-schema.ts';
import { assertWithinLimits } from '../../server/graphql/operation-limits.ts';
import { closeTestDb, createTestDb, type TestDb } from '../helpers.ts';

const { maxAliases, maxDepth, maxPageSize } = OPERATION_LIMIT_DEFAULTS;

let db: TestDb;
let schema: GraphQLSchema;

beforeAll(async () => {
  db = await createTestDb();
  schema = createSchema(db);
});

afterAll(() => closeTestDb(db));

/**
 * Prices a query against the limits.
 *
 * @param query - The operation.
 * @returns The `extensions.code` it is refused with, or undefined when it passes.
 */
function refusalOf(query: string): unknown {
  try {
    assertWithinLimits({ schema, document: parse(query) }, OPERATION_LIMIT_DEFAULTS);
    return undefined;
  } catch (error) {
    return error instanceof Error && 'extensions' in error ? (error.extensions as { code?: unknown }).code : error;
  }
}

/**
 * Builds `{ workspaces { keys { workspace { keys … id } } } }`, `levels` fields deep, one row per list.
 *
 * @param levels - How deep the selection goes.
 * @returns The query.
 */
function nested(levels: number): string {
  const fields = Array.from({ length: levels - 2 }, (_, level) => (level % 2 === 0 ? 'keys(limit: 1)' : 'workspace'));
  return `{ workspaces(limit: 1) { ${fields.join(' { ')} { id ${'} '.repeat(fields.length)}} }`;
}

describe('assertWithinLimits', () => {
  it('allows a query at the depth limit and refuses one level more', () => {
    expect(refusalOf(nested(maxDepth))).toBeUndefined();
    expect(refusalOf(nested(maxDepth + 1))).toBe(ErrorCode.QueryTooComplex);
  });

  it('allows the alias limit and refuses one more', () => {
    const aliased = (count: number) =>
      `{ ${Array.from({ length: count }, (_, index) => `a${index}: workspaces { id }`).join(' ')} }`;
    expect(refusalOf(aliased(maxAliases))).toBeUndefined();
    expect(refusalOf(aliased(maxAliases + 1))).toBe(ErrorCode.QueryTooComplex);
  });

  it('refuses a query that could return more than the cost limit', () => {
    const query = `{ workspaces(limit: ${maxPageSize}) { keys(limit: ${maxPageSize}) { id } } }`;
    expect(refusalOf(query)).toBe(ErrorCode.QueryTooComplex);
  });
});
