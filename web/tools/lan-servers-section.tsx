import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { LanServersDocument, type LanServersQuery } from '@/__generated__/graphql';
import { CardLayout } from '@/components/card-layout';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { RowMeta } from '@/components/row-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { InstallDialog } from './install-dialog';

/** One server found on the local network. */
type LanServer = LanServersQuery['lanServers']['servers'][number];

/** How often the list is read again while the page is open: servers come and go on the network, in milliseconds. */
const REFRESH_MS = 15_000;

/**
 * The MCP servers found on the local network, each offered to add as an HTTP server. Nothing is added until a person
 * adds it: anything on the network can advertise. Draws nothing while the router isn't watching (`MDNS_DISCOVER`).
 */
export function LanServersSection() {
  const [adding, setAdding] = useState<LanServer | null>(null);
  const found = useQuery({
    queryKey: ['lanServers'],
    queryFn: () => request(LanServersDocument),
    refetchInterval: REFRESH_MS,
  });
  if (found.data?.lanServers.watching === false) {
    return null;
  }
  const rows = found.data?.lanServers.servers ?? [];

  return (
    <CardLayout
      level={2}
      title="On your network"
      description="MCP servers announced on the local network. Anything there can announce itself, so add only one you trust."
      contentSlot={
        <>
          <LoadState
            compact
            query={found}
            what="the servers on your network"
            count={rows.length}
            emptySlot={<EmptyState compact title="Nothing found on the network yet." />}
          />
          <List
            label="MCP servers on your network"
            contentSlot={rows.map((server) => (
              <ListItem
                key={server.key}
                title={server.title ?? server.cardName}
                description={server.description}
                meta={
                  <RowMeta
                    facts={[server.host, server.url]}
                    badgesSlot={
                      server.requiredHeaders.length > 0 ? (
                        <Badge variant="outline">Needs {server.requiredHeaders.join(', ')}</Badge>
                      ) : null
                    }
                  />
                }
                actionSlot={
                  server.addedAs === null ? (
                    <Button
                      variant="outline"
                      size="sm"
                      iconSlot={<Plus />}
                      onClick={() => setAdding(server)}
                      content="Add"
                    />
                  ) : (
                    <Badge variant="secondary">Added as {server.addedAs}</Badge>
                  )
                }
              />
            ))}
          />
          {adding === null ? null : (
            <InstallDialog
              key={adding.key}
              open
              onOpenChange={(open) => (open ? undefined : setAdding(null))}
              prefill={{ name: adding.suggestedName, url: adding.url, headerNames: adding.requiredHeaders }}
            />
          )}
        </>
      }
    />
  );
}
