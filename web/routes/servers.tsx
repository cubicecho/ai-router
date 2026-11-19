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
import { describeSource, describeTransport, isBuiltin, sourceOf, transportOf } from '@/tools/shapes';

/** Every MCP server the router's agents may use tools from, and the registries they come from. */
export function ServersRoute() {
  const [isInstalling, setIsInstalling] = useState(false);
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => request(ServersDocument) });
  const rows = servers.data?.servers ?? [];
  // The admin server is on every router, so the list counts as empty until something is installed.
  const installed = rows.filter((server) => isBuiltin(server.transport) === false);
  const add = (
    <Button variant="positive" iconSlot={<Plus />} onClick={() => setIsInstalling(true)} content="Add server" />
  );

  return (
    <PageLayout
      width="page"
      title="MCP Servers"
      description="The MCP servers agents use tools from. A run sees each tool as <server>__<tool>."
      actionSlot={installed.length > 0 ? add : undefined}
      contentSlot={
        <>
          <LoadState
            query={servers}
            what="the servers"
            count={installed.length}
            emptySlot={
              <EmptyState
                iconSlot={<Plug />}
                title="No MCP servers yet"
                description="Install one from a registry, npm or PyPI, or add a program or an HTTP address by hand."
                actionSlot={add}
              />
            }
          />
          <List
            label="MCP servers"
            contentSlot={rows.map((server) => (
              <ListItem
                key={server.id}
                title={server.displayName ?? server.name}
                description={[
                  server.displayName === null ? undefined : server.name,
                  describeTransport(transportOf(server.transport)),
                  // The badge already says the admin server is built in.
                  isBuiltin(server.transport) ? undefined : describeSource(sourceOf(server.source)),
                ]
                  .filter((part) => part !== undefined)
                  .join(' · ')}
                meta={
                  <span className="flex items-center gap-1">
                    {isBuiltin(server.transport) ? <Badge variant="secondary">Built in</Badge> : null}
                    {server.enabled ? null : <Badge variant="outline">Off</Badge>}
                    <LoginBadge login={server.login} />
                  </span>
                }
                linkSlot={<Link to="/mcp-servers/$serverId" params={{ serverId: server.id }} />}
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
