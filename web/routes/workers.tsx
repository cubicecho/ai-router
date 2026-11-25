import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  DeleteWorkerDocument,
  RotateWorkerKeyDocument,
  WorkersDocument,
  type WorkersQuery,
} from '@/__generated__/graphql';
import { CardLayout } from '@/components/card-layout';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { RowMeta } from '@/components/row-meta';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons';
import { formatAgo, formatCount, formatDate } from '@/lib/format';
import { request } from '@/lib/gql';
import { isLocalWorker, localFirst } from '@/workers/shapes';
import { WorkerCommand } from '@/workers/worker-command';
import { WorkerDialog } from '@/workers/worker-dialog';
import { WorkerKeyDialog } from '@/workers/worker-key-dialog';
import { WorkerStatusBadge } from '@/workers/worker-status-badge';

/** One row of the workers list, as its query answers it. */
type WorkerRow = WorkersQuery['workers'][number];

/** A key just rotated, shown once. */
interface Rotated {
  name: string;
  secret: string;
}

/**
 * Says what a worker is: the router itself, or when it was made and by whom.
 *
 * @param worker - The row.
 * @returns Such as "Made Nov 25, 2026 by Ben".
 */
function madeOf(worker: WorkerRow): string {
  if (isLocalWorker(worker)) {
    return 'The router itself. A workspace with no worker set runs here.';
  }
  const by = worker.creator?.name ?? worker.creator?.email;
  const made = `Made ${formatDate(worker.createdAt)}`;
  return by === undefined ? made : `${made} by ${by}`;
}

/**
 * The facts at a worker's far end: the machine and version it said, when it last dialled in, its key's start and the
 * workspaces that run on it.
 *
 * @param worker - The row.
 * @param now - The time ages are counted from, in milliseconds since the epoch.
 * @returns The row's far end.
 */
function metaOf(worker: WorkerRow, now: number) {
  return (
    <RowMeta
      facts={[
        worker.host,
        worker.version === null ? null : `v${worker.version}`,
        worker.lastSeenAt === null ? null : `Seen ${formatAgo(worker.lastSeenAt, now)}`,
        worker.keyPrefix === null ? null : (
          <span key="key" className="font-mono">
            {worker.keyPrefix}…
          </span>
        ),
        formatCount(worker.workspaces.length, 'workspace', 'workspaces'),
      ]}
      badgesSlot={<WorkerStatusBadge worker={worker} />}
    />
  );
}

/**
 * What deleting a worker would do, naming the workspaces that stop it.
 *
 * @param worker - The row.
 * @returns The confirm's description.
 */
function deleteDescriptionOf(worker: WorkerRow): string {
  const names = worker.workspaces.map((workspace) => workspace.name);
  const [first] = names;
  if (first === undefined) {
    return 'Its key stops working at once. The runs it ran stay, naming no worker.';
  }
  if (names.length === 1) {
    return `${first} runs on it. Move that workspace to another worker first, or the delete is refused.`;
  }
  return `${names.join(', ')} run on it. Move them to another worker first, or the delete is refused.`;
}

/** Every worker, `local` first: where each workspace's agent loops run. */
export function WorkersRoute() {
  const queryClient = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [rotated, setRotated] = useState<Rotated | null>(null);
  const workers = useQuery({ queryKey: ['workers'], queryFn: () => request(WorkersDocument) });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['workers'] });
  const rotate = useMutation({
    mutationFn: (id: string) => request(RotateWorkerKeyDocument, { id }),
    onSuccess: ({ rotateWorkerKey }) => {
      setRotated({ name: rotateWorkerKey.worker.name, secret: rotateWorkerKey.secret });
      void invalidate();
    },
  });
  // A worker a workspace runs on is refused with a message naming the workspace, which the app's toast shows.
  const remove = useMutation({
    mutationFn: (id: string) => request(DeleteWorkerDocument, { id }),
    onSuccess: invalidate,
  });
  const rows = localFirst(workers.data?.workers ?? []);
  const hasRemote = rows.some((worker) => isLocalWorker(worker) === false);
  const now = Date.now();
  const create = (
    <Button variant="positive" iconSlot={<Plus />} onClick={() => setIsCreating(true)} content="New worker" />
  );

  return (
    <PageLayout
      width="page"
      title="Workers"
      description="Where each workspace's agent loops run: inside the router, or on another machine that connects with a worker key."
      actionSlot={hasRemote ? create : undefined}
      contentSlot={
        <>
          <LoadState query={workers} what="the workers" count={rows.length} />
          {rows.length > 0 ? (
            <CardLayout
              level={2}
              title="All workers"
              contentSlot={
                <List
                  label="Workers"
                  contentSlot={rows.map((worker) => (
                    <ListItem
                      key={worker.id}
                      title={worker.name}
                      titleClassName="font-mono"
                      description={madeOf(worker)}
                      meta={metaOf(worker, now)}
                      actionSlot={
                        isLocalWorker(worker) ? undefined : (
                          <>
                            <ConfirmButton
                              size="sm"
                              title={`Rotate ${worker.name}'s key?`}
                              description="Its current key stops working at once, so the worker is refused until it is restarted with the new one."
                              confirmLabel="Rotate key"
                              loading={rotate.isPending && rotate.variables === worker.id}
                              onConfirm={() => rotate.mutate(worker.id)}
                              content="Rotate key"
                            />
                            <ConfirmButton
                              size="sm"
                              title={`Delete ${worker.name}?`}
                              description={deleteDescriptionOf(worker)}
                              confirmLabel="Delete worker"
                              loading={remove.isPending && remove.variables === worker.id}
                              onConfirm={() => remove.mutate(worker.id)}
                              content="Delete"
                            />
                          </>
                        )
                      }
                    />
                  ))}
                />
              }
            />
          ) : null}
          {workers.isSuccess && hasRemote === false ? (
            <CardLayout
              level={2}
              title="Run agents on another machine"
              contentSlot={
                <>
                  <EmptyState
                    compact
                    title="No other workers yet. Make one to get its key, then start it where its agents should run."
                    actionSlot={create}
                  />
                  <WorkerCommand />
                </>
              }
            />
          ) : null}
          <WorkerDialog open={isCreating} onOpenChange={setIsCreating} />
          {rotated === null ? null : (
            <WorkerKeyDialog
              open
              onOpenChange={(open) => setRotated(open ? rotated : null)}
              workerName={rotated.name}
              secret={rotated.secret}
            />
          )}
        </>
      }
    />
  );
}
