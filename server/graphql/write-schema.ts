// `npm run codegen`: prints the schema the server serves, so the UI's types are generated from the real thing.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { printSchema } from 'graphql';
import { ROOT } from '../core/config.ts';
import { openDatabase } from '../db/client.ts';
import { createSchema } from './build-schema.ts';

// Building the schema runs no query, so a throwaway database in memory is enough.
const database = openDatabase('memory://');
const outputDir = path.join(ROOT, '__generated__');
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'schema.graphql'), printSchema(createSchema(database.db)), 'utf-8');
await database.close();
