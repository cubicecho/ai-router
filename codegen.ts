import type { CodegenConfig } from '@graphql-codegen/cli';

/** Typed documents for the UI, from the schema `server/graphql/write-schema.ts` prints. */
const config: CodegenConfig = {
  schema: './__generated__/schema.graphql',
  documents: './web/graphql/**/*.graphql',
  ignoreNoDocuments: true,
  generates: {
    './web/__generated__/graphql.ts': {
      plugins: ['typescript-operations', 'typed-document-node'],
      config: {
        // ISO strings on the wire. Parsing into Date invites timezone bugs.
        scalars: { DateTime: 'string', UUID: 'string', JSON: 'unknown' },
        useTypeImports: true,
        skipTypename: true,
        avoidOptionals: { field: true },
      },
    },
  },
};

export default config;
