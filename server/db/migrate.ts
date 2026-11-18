// `npm run db:migrate`: applies the committed migrations to DATABASE_URL and exits. Boot does the same.
import { errorMessage } from '../core/errors.ts';
import { openDatabase } from './client.ts';

const database = openDatabase();
try {
  await database.claim();
  await database.migrate();
  console.log(`[db] migrations applied to ${database.location}`);
} catch (error) {
  console.error(`[db] migrating failed: ${errorMessage(error)}`);
  process.exitCode = 1;
} finally {
  await database.close();
}
