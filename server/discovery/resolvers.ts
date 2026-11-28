import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { Context } from '../core/context.ts';
import { objectType } from '../graphql/object-type.ts';

const DISCOVERY_SDL = parse(`
  """
  An MCP server found on the local network. Only a suggestion: anything on the network can advertise, so a person
  adds it with installServer, as a streamable-http server at its url, and gives the headers it needs.
  """
  type LanServer {
    "Unique on the network: the host's mDNS name and the card's name."
    key: String!
    "The name on its Server Card, such as io.github.cubicecho.mcp-skills.nas/skills."
    cardName: String!
    title: String
    description: String!
    version: String!
    "The host's mDNS name, such as MCP Skills on nas."
    host: String!
    "Its streamable-HTTP endpoint."
    url: String!
    "Headers its card says a client must send, such as Authorization. A person gives their values."
    requiredHeaders: [String!]!
    "A name no server uses yet, made from its card's name."
    suggestedName: String!
    "The server already at its url, or null when none is."
    addedAs: String
  }

  "What the router found on the local network."
  type LanDiscovery {
    "Whether the router is watching the network now. MDNS_DISCOVER turns it on."
    watching: Boolean!
    servers: [LanServer!]!
  }

  extend type Query {
    "MCP servers found on the local network over mDNS, to offer people to add. People only."
    lanServers: LanDiscovery!
  }
`);

/**
 * Adds the servers found on the local network, for people (graphql/permissions).
 *
 * @param schema - The schema so far.
 * @returns The schema with them.
 */
export function applyDiscoveryExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, DISCOVERY_SDL);
  const queries = objectType(extended, 'Query').getFields();

  queries.lanServers.resolve = (_parent: unknown, _args: unknown, ctx: Context) => ({
    watching: ctx.lanServers.isWatching(),
    servers: ctx.lanServers.list(),
  });

  return extended;
}
