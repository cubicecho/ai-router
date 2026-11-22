import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relations } from '../../server/db/relations.ts';
import { loadSnapshot } from '../../server/db/snapshot.ts';

// The migration from servers granted per agent to a workspace's servers, each turned off for some agents, keeps every
// agent's reach exactly: no run reaches a server after it that it couldn't before, and none loses one.

const MIGRATIONS = join(import.meta.dirname, '../../drizzle');
/** The first migration of the change. Every one before it runs first, then the rows the old shape held are added. */
const FIRST_NEW = '20261122185732_workspace_servers';

let client: PGlite;

/**
 * Runs migrations in order, as boot does.
 *
 * @param folders - Their folders' names.
 */
async function migrate(folders: readonly string[]): Promise<void> {
  for (const folder of folders) {
    const sql = readFileSync(join(MIGRATIONS, folder, 'migration.sql'), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim() !== '') {
        await client.exec(statement);
      }
    }
  }
}

/**
 * Inserts a row and answers its id.
 *
 * @param sql - An INSERT that returns `id`.
 * @param params - Its values.
 * @returns The id.
 */
async function insert(sql: string, params: unknown[]): Promise<string> {
  const { rows } = await client.query<{ id: string }>(`${sql} RETURNING id`, params);
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('Nothing was inserted.');
  }
  return id;
}

beforeAll(async () => {
  client = new PGlite('memory://');
});

afterAll(() => client.close());

describe('the move to workspace servers', () => {
  // Every migration runs, one statement at a time.
  it("keeps every agent's reach exactly as its grants had it", { timeout: 60_000 }, async () => {
    const folders = readdirSync(MIGRATIONS).sort();
    const at = folders.indexOf(FIRST_NEW);
    expect(at).toBeGreaterThan(0);
    await migrate(folders.slice(0, at));

    const workspace = (slug: string) => insert('INSERT INTO workspaces (slug, name) VALUES ($1, $1)', [slug]);
    const server = (name: string) =>
      insert(
        `INSERT INTO servers (name, source, transport) VALUES ($1, '{"type":"manual"}', '{"type":"stdio","command":"node","args":[]}')`,
        [name],
      );
    const agent = (name: string) => insert('INSERT INTO agents (name) VALUES ($1)', [name]);
    const offer = (workspaceId: string, agentId: string) =>
      insert('INSERT INTO workspace_agents (workspace_id, agent_id) VALUES ($1, $2)', [workspaceId, agentId]);
    const grant = (workspaceAgentId: string, serverId: string) =>
      insert('INSERT INTO workspace_agent_servers (workspace_agent_id, server_id) VALUES ($1, $2)', [
        workspaceAgentId,
        serverId,
      ]);

    const home = await workspace('home');
    const work = await workspace('work');
    const [actual, github, docs, budget] = [
      await server('actual'),
      await server('github'),
      await server('docs'),
      await server('budget'),
    ];
    const [finance, coder, idle] = [await agent('finance'), await agent('coder'), await agent('idle')];
    await grant(await offer(home, finance), actual);
    const coderAtHome = await offer(home, coder);
    await grant(coderAtHome, github);
    await grant(coderAtHome, docs);
    await offer(home, idle);
    await offer(work, finance);
    // An entry that only configured a server, with no agent granted it.
    await client.query('INSERT INTO workspace_servers (workspace_id, server_id) VALUES ($1, $2)', [home, budget]);

    await migrate(folders.slice(at));

    const snapshot = await loadSnapshot(drizzle({ client, relations }));
    const reach = (name: string, workspaceId: string) => snapshot.agents.get(name)?.workspaces.get(workspaceId);
    expect(reach('finance', home)).toEqual(['actual']);
    expect(reach('coder', home)).toEqual(['docs', 'github']);
    expect(reach('idle', home)).toEqual([]);
    expect(reach('finance', work)).toEqual([]);
    const homeServers = [...snapshot.servers.values()].filter((row) => row.entries.has(home)).map((row) => row.name);
    expect(homeServers.sort()).toEqual(['actual', 'budget', 'docs', 'github']);
  });
});
