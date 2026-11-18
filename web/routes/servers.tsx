import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ServersDocument } from '@/__generated__/graphql';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plug, Plus } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { InstallDialog } from '@/tools/install-dialog';
import { LoginBadge } from '@/tools/login-section';
import { RegistriesSection } from '@/tools/registries-section';
import { describeSource, describeTransport, sourceOf, transportOf } from '@/tools/shapes';

/** Every MCP server the router's agents may use tools from, and the registries they come from. */
export function ServersRoute() {
  const [isInstalling, setIsInstalling] = useState(false);
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => request(ServersDocument) });
  const rows = servers.data?.servers ?? [];
  const add = (
    <Button variant="positive" iconSlot={<Plus />} onClick={() => setIsInstalling(true)} content="Add server" />
  );

  return (
    <PageLayout
      width="prose"
      title="Servers"
      description="The MCP servers agents use tools from. A run sees each tool as <server>__<tool>."
      actionSlot={rows.length > 0 ? add : undefined}
      contentSlot={
        <>
          <LoadState
            query={servers}
            what="the servers"
            count={rows.length}
            emptySlot={
              <EmptyState
                iconSlot={<Plug />}
                title="No servers yet"
                description="Install one from a registry, npm or PyPI, or add one by its command or address."
                actionSlot={add}
              />
            }
          />
          <List
            label="Servers"
            contentSlot={rows.map((server) => (
              <ListItem
                key={server.id}
                title={server.displayName ?? server.name}
                description={`${describeTransport(transportOf(server.transport))} · ${describeSource(sourceOf(server.source))}`}
                meta={
                  <span className="flex gap-1">
                    {server.enabled ? null : <Badge variant="outline">Off</Badge>}
                    <LoginBadge login={server.login} />
                  </span>
                }
                linkSlot={<Link to="/servers/$serverId" params={{ serverId: server.id }} />}
              />
            ))}
          />
          <RegistriesSection />
          <InstallDialog open={isInstalling} onOpenChange={setIsInstalling} />
        </>
      }
    />
  );
}
