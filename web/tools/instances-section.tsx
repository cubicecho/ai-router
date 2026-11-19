import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RestartServerDocument, ServerInstancesDocument } from '@/__generated__/graphql';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadError } from '@/components/load-state';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshCw } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { request } from '@/lib/gql';

/** How often the instances are read again while the page is open. */
const INSTANCES_REFRESH_MS = 3_000;

/** An instance's state, as people read it, with the badge it wears. */
const STATES: Readonly<
  Record<string, { label: string; variant: 'outline' | 'info-soft' | 'positive-soft' | 'destructive-soft' }>
> = {
  stopped: { label: 'Stopped', variant: 'outline' },
  starting: { label: 'Starting', variant: 'info-soft' },
  ready: { label: 'Ready', variant: 'positive-soft' },
  failed: { label: 'Failed', variant: 'destructive-soft' },
};

/**
 * A server's running connections: its own, and one per workspace that overrides its settings. Untitled: its tab
 * names it.
 */
export function InstancesSection({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const instances = useQuery({
    queryKey: ['servers', serverId, 'instances'],
    queryFn: () => request(ServerInstancesDocument, { id: serverId }),
    refetchInterval: INSTANCES_REFRESH_MS,
    meta: { quiet: true },
  });
  const restart = useMutation({
    mutationFn: (workspaceId: string | null) => request(RestartServerDocument, { id: serverId, workspaceId }),
    onSuccess: () => {
      toast('Stopped. The next call starts it fresh.', 'positive');
      void queryClient.invalidateQueries({ queryKey: ['servers', serverId, 'instances'] });
    },
  });
  const rows = instances.data?.server?.instances ?? [];
  const workspaceName = (id: string) =>
    instances.data?.workspaces.find((workspace) => workspace.id === id)?.name ?? 'A workspace';

  return (
    <Section
      description="Started on the first call and stopped once idle. A workspace that overrides its settings gets its own."
      contentSlot={
        instances.isError ? (
          <LoadError error={instances.error} onRetry={instances.refetch} what="its instances" compact />
        ) : rows.length === 0 && instances.isPending === false ? (
          <EmptyState compact title="Not running. The next call starts it." />
        ) : (
          <List
            label="Instances"
            contentSlot={rows.map((instance) => {
              const state = STATES[instance.state] ?? { label: instance.state, variant: 'outline' as const };
              return (
                <ListItem
                  key={instance.workspaceId ?? 'base'}
                  title={
                    instance.workspaceId === null || instance.workspaceId === undefined
                      ? 'Shared'
                      : workspaceName(instance.workspaceId)
                  }
                  description={instance.error ?? undefined}
                  meta={
                    <span className="flex items-center gap-2">
                      <Badge variant={state.variant}>{state.label}</Badge>
                      <span className="text-foreground/60 text-xs tabular-nums">{instance.inFlight} in flight</span>
                    </span>
                  }
                  actionSlot={
                    <Button
                      variant="outline"
                      size="sm"
                      iconSlot={<RefreshCw />}
                      loading={restart.isPending && restart.variables === (instance.workspaceId ?? null)}
                      onClick={() => restart.mutate(instance.workspaceId ?? null)}
                      content="Restart"
                    />
                  }
                />
              );
            })}
          />
        )
      }
    />
  );
}
