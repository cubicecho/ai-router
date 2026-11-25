import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { CancelRunDocument, RunDocument, type RunQuery } from '@/__generated__/graphql';
import { displayNameOf } from '@/agents/shapes';
import { CardLayout } from '@/components/card-layout';
import { ConfirmButton } from '@/components/confirm-button';
import { DetailTabBar, DetailTabPanel, DetailTabs, useDetailTab } from '@/components/detail-tabs';
import { EmptyState } from '@/components/empty-state';
import { LoadError, LoadState } from '@/components/load-state';
import { Markdown } from '@/components/markdown';
import { PageLayout } from '@/components/page-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { CopyButton } from '@/components/ui/copy-button';
import { ArrowLeft } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/spinner';
import { request } from '@/lib/gql';
import { inputMessagesOf } from '@/runs/input';
import { RunInput } from '@/runs/run-input';
import { RunStatusBadge } from '@/runs/run-status-badge';
import { RunTimeline } from '@/runs/run-timeline';
import { RUN_TAB_LABELS, RUN_TABS } from '@/runs/search';
import { durationOf, formatDuration, formatTokens, isOpen, RunStatus, startedOf } from '@/runs/shapes';
import { FollowState, type LiveRunEvent, useRunEvents } from '@/runs/use-run-events';
import { useNow } from '@/runs/use-runs';
import { workerLabelOf } from '@/workers/shapes';

/** How often a running run's row is read again, in case its events stop arriving. */
const RUNNING_REFETCH_MS = 5000;

/** What OpenAI calls a turn cut short by its token limit. */
const FINISH_LENGTH = 'length';

/** How a link inside a fact is drawn, so it reads as one without a hover. */
const LINK_CLASS = 'underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground';

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
  if (run.status === RunStatus.Waiting) {
    return (
      <Alert
        variant="info"
        title="Waiting for the app"
        description="The agent called the app's own tools. The run goes on when the app sends their results, and expires if it never does."
      />
    );
  }
  if (run.status === RunStatus.Expired) {
    return (
      <Alert
        variant="warning"
        title="It expired"
        description={run.error ?? 'The app never answered the tool calls it was handed.'}
      />
    );
  }
  return null;
}

/** The run's facts: what ran, for whom, how it was asked, when, and what it spent. */
function RunFacts({ run, now }: { run: RunRecord; now: number }) {
  const isRunning = isOpen(run.status);
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
                <Link to="/agents/$agentId" params={{ agentId: run.agentId }} className={LINK_CLASS}>
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
                <Link to="/agents/$agentId" params={{ agentId: run.agentId }} className={LINK_CLASS}>
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
                <Link to="/workspaces/$workspaceId" params={{ workspaceId: run.workspaceId }} className={LINK_CLASS}>
                  {run.workspace?.name ?? run.workspaceName}
                </Link>
              )
            }
            hint={run.workspaceId === null ? 'This workspace has since been deleted.' : 'Whose key started it.'}
          />
          {run.worker === null ? null : (
            <PropertyRow
              label="Worker"
              value={
                <Link to="/workers" className={LINK_CLASS}>
                  {workerLabelOf(run.worker)}
                </Link>
              }
              valueClassName="font-mono"
              hint="Where its agent loop ran."
            />
          )}
          <PropertyRow
            label="Session"
            value={
              run.sessionKey === null ? (
                'None'
              ) : (
                <Link
                  to="/agent-runs"
                  search={{ session: run.sessionKey, workspace: run.workspaceId ?? undefined }}
                  className={`${LINK_CLASS} font-mono`}
                >
                  {run.sessionKey}
                </Link>
              )
            }
            hint={
              run.sessionKey === null
                ? 'Sent with no X-Session-Id or X-Conversation-Id, so it belongs to no session.'
                : "The conversation's key, or the X-Session-Id the app sent. Opens the session's runs."
            }
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
            value={`${formatTokens(run)}${isRunning ? ' so far' : ''}`}
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

/**
 * Writes a run's events as the server sent them, one JSON object a line.
 *
 * @param events - The events, in the order they arrived.
 * @returns The lines.
 */
function rawEventsOf(events: readonly LiveRunEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

/** One run, in tabs: what it did and answered, its facts, and its events as they came. */
export function RunRoute() {
  const { runId } = useParams({ from: '/app/agent-runs/$runId' });
  const queryClient = useQueryClient();
  const run = useQuery({
    queryKey: ['runs', runId],
    queryFn: () => request(RunDocument, { id: runId }),
    refetchInterval: (query) => (isOpen(query.state.data?.run?.status ?? '') ? RUNNING_REFETCH_MS : false),
  });
  const live = useRunEvents(runId, () => void queryClient.invalidateQueries({ queryKey: ['runs'] }));
  const { tab, showTab } = useDetailTab(RUN_TABS);
  const cancel = useMutation({
    mutationFn: () => request(CancelRunDocument, { id: runId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['runs'] }),
  });
  const record = run.data?.run ?? undefined;
  const isRunning = isOpen(record?.status ?? '');
  const now = useNow(isRunning);
  const back = (
    <Button variant="outline" size="sm" iconSlot={<ArrowLeft />} linkSlot={<Link to="/agent-runs" />} content="Runs" />
  );

  if (record === undefined) {
    return (
      <PageLayout
        title="Run"
        backSlot={back}
        width="page"
        loading={run.isPending}
        contentSlot={<LoadState query={run} what="this run" record={record} notFoundLabel="Run not found" level={2} />}
      />
    );
  }

  const answer = answerOf(record.answer);
  const isFollowing = live.state === FollowState.Following;
  const title = record.agent === null ? record.agentName : displayNameOf(record.agent);
  const raw = rawEventsOf(live.events);

  /** What stands in for the events before there are any, or once following them failed; null when there are some. */
  const noEvents = () => {
    if (live.state === FollowState.Failed) {
      return <LoadError error={live.error} onRetry={live.retry} what="its live events" compact />;
    }
    if (live.events.length > 0) {
      return null;
    }
    if (isFollowing) {
      return <EmptyState compact title="Waiting for its first event." />;
    }
    return <EmptyState compact title={isRunning ? 'No events yet.' : 'It recorded no events.'} />;
  };

  return (
    <DetailTabs value={tab} onValueChange={showTab}>
      <PageLayout
        title={title}
        description={
          record.worker === null
            ? `Started ${startedOf(record.startedAt)}, from ${record.workspaceName}.`
            : `Started ${startedOf(record.startedAt)}, from ${record.workspaceName}, on ${workerLabelOf(record.worker)}.`
        }
        backSlot={back}
        width="page"
        actionSlot={
          <>
            <RunStatusBadge status={record.status} />
            {isRunning ? (
              <ConfirmButton
                title="Cancel this run?"
                description="It stops where it is, and the app that started it gets an error instead of an answer. A cancelled run can't be carried on."
                confirmLabel="Cancel run"
                cancelLabel="Keep it going"
                loading={cancel.isPending}
                onConfirm={() => cancel.mutate()}
                content="Cancel"
              />
            ) : null}
          </>
        }
        headerBarSlot={<DetailTabBar tabs={RUN_TABS} labels={RUN_TAB_LABELS} label="Run tabs" />}
        contentSlot={
          <>
            <DetailTabPanel value="timeline">
              <RunInput messages={inputMessagesOf(record.input)} />
              <EndedAlert run={record} />
              {answer === null ? null : (
                <CardLayout
                  level={2}
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
                      <Markdown content={answer.content} />
                    )
                  }
                />
              )}
              <CardLayout
                level={2}
                description="Its exchanges, turns, tool calls and results, side tasks and usage, as they happened. Open a row for its detail."
                actionSlot={
                  isFollowing && live.events.length > 0 && isRunning ? (
                    <span className="flex items-center gap-2 text-foreground/60 text-sm">
                      <Spinner label="Following the run" />
                      Live
                    </span>
                  ) : undefined
                }
                contentSlot={
                  noEvents() ?? (
                    <RunTimeline events={live.events} startedAt={Date.parse(record.startedAt)} isLive={isFollowing} />
                  )
                }
              />
            </DetailTabPanel>
            <DetailTabPanel value="details">
              <Section
                description="What ran, for whom, how the app asked, when, and what it spent."
                contentSlot={<RunFacts run={record} now={now} />}
              />
            </DetailTabPanel>
            <DetailTabPanel value="events">
              <Section
                description="Every event as the router sent it, one JSON object a line."
                contentSlot={
                  noEvents() ?? (
                    <CodeBlock
                      title={`run-${record.id}.jsonl`}
                      language="jsonl"
                      content={raw}
                      wrap
                      maxHeight="lg"
                      follow={isFollowing}
                      actionSlot={<CopyButton value={raw} label="Copy the events" />}
                    />
                  )
                }
              />
            </DetailTabPanel>
          </>
        }
      />
    </DetailTabs>
  );
}
