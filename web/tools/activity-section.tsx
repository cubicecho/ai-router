import { useQuery } from '@tanstack/react-query';
import { ServerActivityDocument } from '@/__generated__/graphql';
import { EmptyState } from '@/components/empty-state';
import { LoadError, RowSkeleton } from '@/components/load-state';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { request } from '@/lib/gql';

/** How many of the latest calls the section shows. */
const RECENT_CALLS = 50;

const NUMBER = new Intl.NumberFormat();

/**
 * The latest tool calls made through one server: when, which tool, how long, and whether it failed. Untitled: its
 * tab names it.
 */
export function ActivitySection({ serverId }: { serverId: string }) {
  const activity = useQuery({
    queryKey: ['servers', serverId, 'activity'],
    queryFn: () => request(ServerActivityDocument, { serverId, limit: RECENT_CALLS }),
  });
  const rows = activity.data?.activities ?? [];

  const body = () => {
    if (activity.isError) {
      return <LoadError error={activity.error} onRetry={activity.refetch} what="its activity" compact />;
    }
    if (activity.isPending) {
      return <RowSkeleton rows={3} />;
    }
    if (rows.length === 0) {
      return <EmptyState compact title="No calls yet." />;
    }
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Tool</TableHead>
            <TableHead>From</TableHead>
            <TableHead className="text-right">Took</TableHead>
            <TableHead>Result</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="whitespace-nowrap text-xs">{new Date(row.at).toLocaleString()}</TableCell>
              <TableCell className="font-mono text-xs">{row.tool}</TableCell>
              <TableCell className="text-xs">{row.agentName ?? row.workspaceName ?? 'Tried here'}</TableCell>
              <TableCell className="text-right text-xs tabular-nums">{NUMBER.format(row.durationMs)} ms</TableCell>
              <TableCell className="text-xs">
                {row.ok ? (
                  <Badge variant="positive-soft">OK</Badge>
                ) : (
                  <span className="grid gap-1">
                    <Badge variant="destructive-soft">Failed</Badge>
                    {row.error === null || row.error === undefined ? null : (
                      <span className="text-foreground/70">{row.error}</span>
                    )}
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  };

  return (
    <Section
      description={`The latest ${RECENT_CALLS} calls through it, kept for 30 days. Never what was sent or answered.`}
      contentSlot={body()}
    />
  );
}
