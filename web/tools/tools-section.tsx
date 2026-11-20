import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ServerToolsDocument } from '@/__generated__/graphql';
import { CardLayout } from '@/components/card-layout';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { RowMeta, rowNameFact } from '@/components/row-meta';
import { Button } from '@/components/ui/button';
import { Play, RefreshCw } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { type ServerTool, TryToolDialog } from './try-tool-dialog';

/** What the tools section is given. */
export interface ToolsSectionProps {
  serverId: string;
  serverName: string;
  /** Whether the server takes calls. Off, its tools aren't asked for. */
  enabled: boolean;
  /** Whether a person may try its tools. The admin server's are for agent runs only. */
  canTry: boolean;
}

/** What a server offers now, asked of it, with a way to try each tool. Untitled: its tab names it. */
export function ToolsSection({ serverId, serverName, enabled, canTry }: ToolsSectionProps) {
  const [trying, setTrying] = useState<ServerTool | null>(null);
  const tools = useQuery({
    queryKey: ['servers', serverId, 'tools'],
    queryFn: () => request(ServerToolsDocument, { id: serverId }),
    enabled,
    meta: { quiet: true },
  });
  const rows = tools.data?.serverTools ?? [];

  const body = () => {
    if (enabled === false) {
      return <EmptyState compact title="It is off, so its tools aren't listed." />;
    }
    return (
      <>
        <LoadState
          compact
          query={tools}
          what="its tools"
          count={rows.length}
          rows={3}
          emptySlot={<EmptyState compact title="It offers no tools." />}
        />
        <List
          label="Tools"
          contentSlot={rows.map((tool) => (
            <ListItem
              key={tool.name}
              title={tool.title ?? tool.name}
              description={tool.description ?? undefined}
              meta={<RowMeta facts={[rowNameFact(tool.title, tool.name)]} />}
              actionSlot={
                canTry ? (
                  <Button
                    variant="outline"
                    size="sm"
                    iconSlot={<Play />}
                    onClick={() => setTrying(tool)}
                    content="Try"
                  />
                ) : undefined
              }
            />
          ))}
        />
      </>
    );
  };

  return (
    <CardLayout
      level={2}
      description={
        canTry
          ? `What it offers now. A run sees each as ${serverName}__<tool>. Listing them starts it if it isn't running.`
          : `Everything it offers. A run sees each as ${serverName}__<tool>, and only those its workspace's roles reach.`
      }
      actionSlot={
        enabled ? (
          <Button
            variant="outline"
            size="sm"
            iconSlot={<RefreshCw />}
            loading={tools.isFetching}
            onClick={() => void tools.refetch()}
            content="Refresh"
          />
        ) : undefined
      }
      contentSlot={
        <>
          {body()}
          {trying === null ? null : (
            <TryToolDialog
              key={trying.name}
              open
              onOpenChange={(open) => (open ? undefined : setTrying(null))}
              serverId={serverId}
              serverName={serverName}
              tool={trying}
            />
          )}
        </>
      }
    />
  );
}
