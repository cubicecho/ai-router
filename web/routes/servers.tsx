import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { RegistriesDocument, ServersDocument } from '@/__generated__/graphql';
import { CardLayout } from '@/components/card-layout';
import { DetailTabBar, DetailTabPanel, DetailTabs, useDetailTab } from '@/components/detail-tabs';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { RowMeta, rowNameFact } from '@/components/row-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plug, Plus } from '@/components/ui/icons';
import { joinStats } from '@/lib/format';
import { request } from '@/lib/gql';
import { InstallDialog } from '@/tools/install-dialog';
import { LanServersSection } from '@/tools/lan-servers-section';
import { LoginBadge } from '@/tools/login-section';
import { RegistriesSection } from '@/tools/registries-section';
import { SERVERS_PAGE_TAB_LABELS, SERVERS_PAGE_TABS } from '@/tools/server-tabs';
import { describeSource, describeTransport, isBuiltin, sourceOf, transportOf } from '@/tools/shapes';

/** Every MCP server the router's agents may use tools from, and the registries they come from. */
export function ServersRoute() {
  const [isInstalling, setIsInstalling] = useState(false);
  const { tab, showTab } = useDetailTab(SERVERS_PAGE_TABS);
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => request(ServersDocument) });
  // The Registries tab reads the same query, so its count costs nothing more.
  const registries = useQuery({ queryKey: ['registries'], queryFn: () => request(RegistriesDocument) });
  const rows = servers.data?.servers ?? [];
  // The admin server is on every router, so the list counts as empty until something is installed.
  const installed = rows.filter((server) => isBuiltin(server.transport) === false);
  const add = (
    <Button variant="positive" iconSlot={<Plus />} onClick={() => setIsInstalling(true)} content="Add server" />
  );

  return (
    <DetailTabs value={tab} onValueChange={showTab}>
      <PageLayout
        width="page"
        title="MCP Servers"
        description="The MCP servers agents use tools from. A run sees each tool as <server>__<tool>."
        actionSlot={tab === 'servers' && installed.length > 0 ? add : undefined}
        headerBarSlot={
          <DetailTabBar
            tabs={SERVERS_PAGE_TABS}
            labels={SERVERS_PAGE_TAB_LABELS}
            label="MCP servers, or registries"
            trailing={{
              servers: servers.data === undefined ? undefined : <Badge variant="secondary">{rows.length}</Badge>,
              registries:
                registries.data === undefined ? undefined : (
                  <Badge variant="secondary">{registries.data.registries.length}</Badge>
                ),
            }}
          />
        }
        contentSlot={
          <>
            <DetailTabPanel value="servers">
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
              {rows.length > 0 ? (
                <CardLayout
                  level={2}
                  title="All servers"
                  contentSlot={
                    <List
                      label="MCP servers"
                      contentSlot={rows.map((server) => (
                        <ListItem
                          key={server.id}
                          title={server.displayName ?? server.name}
                          description={joinStats(
                            describeTransport(transportOf(server.transport)),
                            // The badge already says the admin server is built in.
                            isBuiltin(server.transport) ? undefined : describeSource(sourceOf(server.source)),
                          )}
                          meta={
                            <RowMeta
                              facts={[rowNameFact(server.displayName, server.name)]}
                              badgesSlot={
                                <>
                                  {isBuiltin(server.transport) ? <Badge variant="secondary">Built in</Badge> : null}
                                  <LoginBadge login={server.login} />
                                  {server.enabled ? null : <Badge variant="outline">Off</Badge>}
                                </>
                              }
                            />
                          }
                          linkSlot={<Link to="/mcp-servers/$serverId" params={{ serverId: server.id }} />}
                        />
                      ))}
                    />
                  }
                />
              ) : null}
              <LanServersSection />
            </DetailTabPanel>
            <DetailTabPanel value="registries">
              <RegistriesSection />
            </DetailTabPanel>
            <InstallDialog open={isInstalling} onOpenChange={setIsInstalling} />
          </>
        }
      />
    </DetailTabs>
  );
}
