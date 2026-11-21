import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../server/core/config.ts';
import { relations } from '../../server/db/relations.ts';
import { registries } from '../../server/db/tables/registries.ts';
import { servers } from '../../server/db/tables/servers.ts';
import { ADMIN_SERVER_ROW } from '../../server/tools/shapes.ts';

// Every migration runs on a fresh PGlite: about 4 s alone, and past Vitest's 5 s default when the machine is busy.
const MIGRATE_TIMEOUT_MS = 30_000;

describe('the migrations', () => {
  it('seed the official registry and the admin server, as the code describes it', {
    timeout: MIGRATE_TIMEOUT_MS,
  }, async () => {
    const client = new PGlite('memory://');
    const db = drizzle({ client, relations });
    try {
      await migrate(db, { migrationsFolder: path.join(ROOT, 'drizzle') });
      expect(await db.select({ name: registries.name, url: registries.url }).from(registries)).toEqual([
        { name: 'official', url: 'https://registry.modelcontextprotocol.io' },
      ]);
      const seeded = await db.select().from(servers);
      expect(
        seeded.map(({ name, displayName, description, source, transport, env, enabled }) => ({
          name,
          displayName,
          description,
          source,
          transport,
          env,
          enabled,
        })),
      ).toEqual([{ ...ADMIN_SERVER_ROW, env: {}, enabled: true }]);
    } finally {
      await client.close();
    }
  });
});
