import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { RunDocument, type RunQuery } from '@/__generated__/graphql';
import { displayNameOf } from '@/agents/shapes';
import { EmptyState } from '@/components/empty-state';
import { LoadError, LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { ArrowLeft } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/spinner';
import { request } from '@/lib/gql';
import { RunStatusBadge } from '@/runs/run-status-badge';
import { RunTimeline } from '@/runs/run-timeline';
import { CELL_LINK_CLASS } from '@/runs/runs-table';
import { durationOf, formatCount, formatDuration, formatTokens, RunStatus, startedOf } from '@/runs/shapes';
import { latestUsage } from '@/runs/timeline';
import { FollowState, useRunEvents } from '@/runs/use-run-events';
import { useNow } from '@/runs/use-runs';

/** How often a running run's row is read again, in case its events stop arriving. */
const RUNNING_REFETCH_MS = 5000;

/** What OpenAI calls a turn cut short by its token limit. */
const FINISH_LENGTH = 'length';

/** One run as the page reads it. */
type RunRecord = NonNullable<RunQuery['run']>;

/** A finished run's answer, as the runs table keeps it. */
interface Answer {
  content: string;
  finishReason: string;
}

/**
 * Reads a run's stored answer.
 *
 * @param answer - The `answer` column, JSON on the wire.
 * @returns The answer, or null when there is none.
 */
function answerOf(answer: unknown): Answer | null {
  if (typeof answer !== 'object' || answer === null) {
    return null;
  }
  const { content, finishReason } = answer as Record<string, unknown>;
  return typeof content === 'string'
    ? { content, finishReason: typeof finishReason === 'string' ? finishReason : '' }
    : null;
}

/** What ended a run that did not complete, as a callout. */
function EndedAlert({ run }: { run: RunRecord }) {
  if (run.status === RunStatus.Failed) {
    return <Alert variant="destructive" title="It failed" description={run.error ?? 'It gave no reason.'} />;
  }
  if (run.status === RunStatus.Cancelled) {
    return <Alert variant="warning" title="It was cancelled" description={run.error ?? 'It gave no reason.'} />;
  }
  return null;
}

/** The run's facts: what ran, for whom, how it was asked, when, and what it spent. */
function RunFacts({ run, now, liveTokens }: { run: RunRecord; now: number; liveTokens: string | null }) {
  const isRunning = run.status === RunStatus.Running;
  const agentName = run.agent === null ? run.agentName : displayNameOf(run.agent);
  return (
    <PropertyList
      contentSlot={
        <>
          <PropertyRow
            label="Agent"
            value={
              run.agentId === null ? (
                run.agentName
              ) : (
                <Link to="/agents/$agentId" params={{ agentId: run.agentId }} className={CELL_LINK_CLASS}>
                  {agentName}
                </Link>
              )
            }
            hint={run.agentId === null ? 'This agent has since been deleted.' : run.agentName}
          />
          <PropertyRow
            label="Revision"
            value={
              run.revision === null || run.agentId === null ? (
                'Deleted'
              ) : (
                <Link to="/agents/$agentId" params={{ agentId: run.agentId }} className={CELL_LINK_CLASS}>
                  Revision {run.revision.number}
                </Link>
              )
            }
            hint="What it ran, from the agent's history. A revision made live later applies to later runs."
          />
          <PropertyRow
            label="Workspace"
            value={
              run.workspaceId === null ? (
                run.workspaceName
              ) : (
                <Link
                  to="/workspaces/$workspaceId"
                  params={{ workspaceId: run.workspaceId }}
                  className={CELL_LINK_CLASS}
                >
                  {run.workspace?.name ?? run.workspaceName}
                </Link>
              )
            }
            hint={run.workspaceId === null ? 'This workspace has since been deleted.' : 'Whose key started it.'}
          />
          <PropertyRow
            label="User"
            value={run.user ?? 'Not sent'}
            valueClassName={run.user === null ? undefined : 'font-mono'}
            hint="The request's user field, which the app sends for its own reference."
          />
          <PropertyRow label="Streamed" value={run.stream ? 'Yes' : 'No'} />
          <PropertyRow
            label="Idempotency key"
            value={run.idempotencyKey ?? 'None'}
            valueClassName={run.idempotencyKey === null ? undefined : 'font-mono break-all'}
            hint="A retry with the same key gets this run's answer instead of starting another. Kept for 24 hours."
            actionSlot={
              run.idempotencyKey === null ? undefined : (
                <CopyButton value={run.idempotencyKey} label="Copy the idempotency key" />
              )
            }
          />
          <PropertyRow label="Started" value={startedOf(run.startedAt)} />
          <PropertyRow label="Finished" value={run.finishedAt === null ? 'Not yet' : startedOf(run.finishedAt)} />
          <PropertyRow label="Took" value={`${formatDuration(durationOf(run, now))}${isRunning ? ' so far' : ''}`} />
          <PropertyRow
            label="Tokens"
            value={isRunning ? (liveTokens ?? 'Counted after its first turn') : formatTokens(run)}
            hint="Over the main loop's model calls, as the provider reported them."
          />
          <PropertyRow
            label="Run id"
            value={run.id}
            valueClassName="font-mono break-all"
            hint="The app gets it as X-Run-Id."
            actionSlot={<CopyButton value={run.id} label="Copy the run id" />}
          />
        </>
      }
    />
  );
}

/** One run: its facts, its answer, and, while it runs, what it is doing. */
export function RunRoute() {
  const { runId } = useParams({ from: '/app/agent-runs/$runId' });
  const queryClient = useQueryClient();
  const run = useQuery({
    queryKey: ['runs', runId],
    queryFn: () => request(RunDocument, { id: runId }),
    refetchInterval: (query) => (query.state.data?.run?.status === RunStatus.Running ? RUNNING_REFETCH_MS : false),
  });
  const live = useRunEvents(runId, () => void queryClient.invalidateQueries({ queryKey: ['runs'] }));
  const record = run.data?.run ?? undefined;
  const isRunning = record?.status === RunStatus.Running;
  const now = useNow(isRunning);
  const back = (
    <Button variant="outline" size="sm" iconSlot={<ArrowLeft />} linkSlot={<Link to="/agent-runs" />} content="Runs" />
  );

  if (record === undefined) {
    return (
      <PageLayout
        title="Run"
        backSlot={back}
        loading={run.isPending}
        contentSlot={<LoadState query={run} what="this run" record={record} notFoundLabel="Run not found" level={2} />}
      />
    );
  }

  const answer = answerOf(record.answer);
  const usage = latestUsage(live.events);
  const liveTokens =
    usage === null ? null : `${formatCount(usage.promptTokens)} in · ${formatCount(usage.completionTokens)} out so far`;
  const isFollowing = live.state === FollowState.Following;
  const title = record.agent === null ? record.agentName : displayNameOf(record.agent);

  const events = () => {
    if (live.state === FollowState.Failed) {
      return <LoadError error={live.error} onRetry={live.retry} what="its live events" compact />;
    }
    if (live.events.length === 0) {
      return isFollowing ? (
        <EmptyState compact title="Waiting for its first event." />
      ) : (
        <EmptyState
          compact
          title={
            isRunning
              ? 'No events yet.'
              : "Events are kept only while a run is live, and for a minute after, so this one's are gone."
          }
        />
      );
    }
    const isTail = live.events.every((event) => event.seq > 1);
    return (
      <>
        {/* The router holds a run's latest thousand events, so a page opened late sees only those. */}
        {isTail ? <EmptyState compact title="Its earlier events are no longer held." /> : null}
        <RunTimeline events={live.events} startedAt={Date.parse(record.startedAt)} isLive={isFollowing} />
      </>
    );
  };

  return (
    <PageLayout
      title={title}
      description={`Started ${startedOf(record.startedAt)}, from ${record.workspaceName}.`}
      backSlot={back}
      width="prose"
      actionSlot={<RunStatusBadge status={record.status} />}
      contentSlot={
        <>
          <EndedAlert run={record} />
          <RunFacts run={record} now={now} liveTokens={liveTokens} />
          {answer === null ? null : (
            <Section
              title="Answer"
              description={
                answer.finishReason === FINISH_LENGTH
                  ? 'Cut short: its last turn reached the token limit.'
                  : "Every turn's text, a blank line between turns, as the app received it."
              }
              actionSlot={
                answer.content === '' ? undefined : <CopyButton value={answer.content} label="Copy the answer" />
              }
              contentSlot={
                answer.content === '' ? (
                  <EmptyState compact title="It wrote nothing." />
                ) : (
                  <p className="whitespace-pre-wrap break-words text-sm">{answer.content}</p>
                )
              }
            />
          )}
          <Section
            title="Events"
            description="Its steps, turns, tool calls and results, side tasks and usage, as they happened."
            actionSlot={
              isFollowing && live.events.length > 0 && isRunning ? (
                <span className="flex items-center gap-2 text-foreground/70 text-sm">
                  <Spinner label="Following the run" />
                  Live
                </span>
              ) : undefined
            }
            contentSlot={events()}
          />
        </>
      }
    />
  );
}
