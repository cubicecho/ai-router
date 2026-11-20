import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type GraphQLInputType,
  type GraphQLSchema,
  isEnumType,
  isInputObjectType,
  isInputType,
  isListType,
  isNonNullType,
  Kind,
  type OperationDefinitionNode,
  parse,
  typeFromAST,
} from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from '../../server/core/config.ts';
import { OPERATION_LIMIT_DEFAULTS } from '../../server/core/defaults.ts';
import { createSchema } from '../../server/graphql/build-schema.ts';
import { assertWithinLimits } from '../../server/graphql/operation-limits.ts';
import { closeTestDb, createTestDb, type TestDb } from '../helpers.ts';

/** Where the UI's operations are written. */
const OPERATIONS_DIR = path.join(ROOT, 'web', 'graphql');

/** A value for each scalar a variable may be, so the operation prices: without them it is priced at nothing. */
const SCALAR_VALUES: Readonly<Record<string, unknown>> = {
  // A `$limit` is priced at a default page: the UI never asks for more.
  Int: OPERATION_LIMIT_DEFAULTS.defaultPageSize,
  Float: 1,
  String: 'x',
  Boolean: false,
  ID: '00000000-0000-4000-8000-000000000000',
  UUID: '00000000-0000-4000-8000-000000000000',
  JSON: {},
  DateTime: '2026-01-01T00:00:00.000Z',
};

/**
 * Makes up a value of a variable's type.
 *
 * @param type - The variable's type.
 * @returns A value the type accepts, or undefined for an input object, which is left out when it may be.
 */
function sampleOf(type: GraphQLInputType): unknown {
  const inner = isNonNullType(type) ? type.ofType : type;
  if (isListType(inner)) {
    return [];
  }
  if (isEnumType(inner)) {
    return inner.getValues()[0]?.value;
  }
  if (isInputObjectType(inner)) {
    return isNonNullType(type) ? {} : undefined;
  }
  return SCALAR_VALUES[inner.name];
}

/**
 * Makes up a value for each of an operation's variables.
 *
 * @param operation - The operation.
 * @returns Its variables.
 */
function variablesOf(operation: OperationDefinitionNode): Record<string, unknown> {
  return Object.fromEntries(
    (operation.variableDefinitions ?? []).flatMap((definition) => {
      const type = typeFromAST(schema, definition.type);
      const value = type !== undefined && isInputType(type) ? sampleOf(type) : undefined;
      return value === undefined ? [] : [[definition.variable.name.value, value]];
    }),
  );
}

let db: TestDb;
let schema: GraphQLSchema;

/**
 * Reads every file of the UI's operations as one document, so each operation finds its fragments.
 *
 * @returns The document's source.
 */
async function operationsSource(): Promise<string> {
  const files = (await readdir(OPERATIONS_DIR)).filter((file) => file.endsWith('.graphql')).sort();
  const sources = await Promise.all(files.map((file) => readFile(path.join(OPERATIONS_DIR, file), 'utf-8')));
  return sources.join('\n');
}

beforeAll(async () => {
  db = await createTestDb();
  schema = createSchema(db);
});

afterAll(() => closeTestDb(db));

describe("the UI's operations", () => {
  it('each fit the operation limits, so no screen is refused as too costly', async () => {
    const document = parse(await operationsSource());
    const operations = document.definitions.filter(
      (definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION,
    );
    expect(operations.length).toBeGreaterThan(0);
    const refused = operations.flatMap((operation) => {
      const operationName = operation.name?.value ?? '(anonymous)';
      try {
        assertWithinLimits(
          { schema, document, operationName, variables: variablesOf(operation) },
          OPERATION_LIMIT_DEFAULTS,
        );
        return [];
      } catch (error) {
        return [`${operationName}: ${error instanceof Error ? error.message : String(error)}`];
      }
    });
    expect(refused).toEqual([]);
  });
});
