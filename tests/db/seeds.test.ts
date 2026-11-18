import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_RULES } from '../../server/agents/policy.ts';
import { ROOT } from '../../server/core/config.ts';
import { relations } from '../../server/db/relations.ts';
import { DEFAULT_POLICY_ID, overridePolicies } from '../../server/db/tables/override-policies.ts';
import { registries } from '../../server/db/tables/registries.ts';

describe('the migrations', () => {
  it('seed the official registry and the default override policy, as the code describes it', async () => {
    const client = new PGlite('memory://');
    const db = drizzle({ client, relations });
    try {
      await migrate(db, { migrationsFolder: path.join(ROOT, 'drizzle') });
      expect(await db.select({ name: registries.name, url: registries.url }).from(registries)).toEqual([
        { name: 'official', url: 'https://registry.modelcontextprotocol.io' },
      ]);
      const policies = await db.select().from(overridePolicies);
      expect(policies.map(({ id, name, rules }) => ({ id, name, rules }))).toEqual([
        { id: DEFAULT_POLICY_ID, name: 'default', rules: DEFAULT_POLICY_RULES },
      ]);
    } finally {
      await client.close();
    }
  });
});
