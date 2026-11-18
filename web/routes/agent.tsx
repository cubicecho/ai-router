import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { AgentDocument, DeleteAgentDocument } from '@/__generated__/graphql';
import { AgentEditorDialog } from '@/agents/agent-editor-dialog';
import { Findings } from '@/agents/findings';
import { HistorySection } from '@/agents/history-section';
import { describeServers, describeTaskModel, documentText, factsOf, stringsOf, whenOf, whoOf } from '@/agents/shapes';
import { ConfirmButton } from '@/components/confirm-button';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { CopyButton } from '@/components/ui/copy-button';
import { ArrowLeft, Pencil } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { RecentRunsSection } from '@/runs/recent-runs-section';

/**
 * Says which workspaces offer an agent.
 *
 * @param names - The workspaces' names.
 * @returns The names, or what having none means.
 */
function describeWorkspaces(names: readonly string[]): string {
  return names.length === 0 ? 'None yet, so no app can run it' : names.join(', ');
}

/** One agent: what its live document says, the document itself, and every revision before it. */
export function AgentRoute() {
  const { agentId } = useParams({ from: '/app/agents/$agentId' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const agent = useQuery({
    queryKey: ['agents', agentId],
    queryFn: () => request(AgentDocument, { id: agentId }),
  });
  const remove = useMutation({
    mutationFn: () => request(DeleteAgentDocument, { id: agentId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      void navigate({ to: '/agents' });
    },
  });
  const record = agent.data?.agent ?? undefined;
  const back = (
    <Button variant="outline" size="sm" iconSlot={<ArrowLeft />} linkSlot={<Link to="/agents" />} content="Agents" />
  );

  if (record === undefined) {
    return (
      <PageLayout
        title="Agent"
        backSlot={back}
        loading={agent.isPending}
        contentSlot={
          <LoadState query={agent} what="this agent" record={record} notFoundLabel="Agent not found" level={2} />
        }
      />
    );
  }

  const live = record.liveRevision ?? null;
  // With none live, the editor starts from the newest revision rather than from nothing.
  const newest = record.revisions[0] ?? null;
  const facts = factsOf(live?.document);
  const workspaces = record.workspaces.flatMap((entry) => (entry.workspace === null ? [] : [entry.workspace.name]));
  const text = live === null ? null : documentText(live.document);

  return (
    <PageLayout
      title={facts.name ?? record.name}
      description={facts.description ?? undefined}
      backSlot={back}
      width="prose"
      actionSlot={
        <>
          <Button variant="outline" iconSlot={<Pencil />} onClick={() => setIsEditing(true)} content="Edit" />
          <ConfirmButton
            title={`Delete ${record.name}?`}
            description="Every revision goes with it, and the workspaces offering it stop doing so. Apps that run it are refused from their next request."
            requireText={record.name}
            onConfirm={() => remove.mutate()}
            content="Delete"
          />
        </>
      }
      contentSlot={
        <>
          {live === null ? (
            <Alert
              variant="warning"
              title="It can't run"
              description="No revision is live. Make one live from the history below."
            />
          ) : (
            <Findings findings={{ errors: [], warnings: stringsOf(live.warnings) }} />
          )}
          <PropertyList
            contentSlot={
              <>
                <PropertyRow
                  label="Name"
                  value={record.name}
                  valueClassName="font-mono"
                  hint="What an app sends as its model to run it. It never changes."
                  actionSlot={<CopyButton value={record.name} label="Copy the name" />}
                />
                {live === null ? null : (
                  <>
                    <PropertyRow
                      label="Model"
                      value={facts.model ?? 'None named, so it cannot run'}
                      valueClassName={facts.model === null ? undefined : 'font-mono'}
                      hint={facts.temperature === null ? undefined : `Temperature ${facts.temperature}`}
                    />
                    <PropertyRow
                      label="Servers"
                      value={describeServers(facts.servers)}
                      valueClassName={facts.servers !== null && facts.servers.length > 0 ? 'font-mono' : undefined}
                      hint={
                        facts.servers === null
                          ? 'Every enabled server except the admin server.'
                          : 'Its tools come from these.'
                      }
                    />
                    {facts.tasks.map((task) => (
                      <PropertyRow
                        key={task.name}
                        label={`The ${task.name} task`}
                        value={describeTaskModel(task.model)}
                        valueClassName={task.model === null || task.model === '' ? undefined : 'font-mono'}
                        hint="A side task, run on its own model."
                      />
                    ))}
                  </>
                )}
                <PropertyRow
                  label="Offered in"
                  value={describeWorkspaces(workspaces)}
                  hint="An app sees the agents its workspace offers. Add it from a workspace's page."
                />
              </>
            }
          />
          {live === null || text === null ? null : (
            <Section
              title="Live document"
              description={`Revision ${live.number}, saved by ${whoOf(live.creator)}, ${whenOf(live.createdAt)}.`}
              contentSlot={
                <CodeBlock
                  title={`${record.name}.json`}
                  language="json"
                  content={text}
                  maxHeight="lg"
                  actionSlot={<CopyButton value={text} label="Copy the document" />}
                />
              }
            />
          )}
          <RecentRunsSection where={{ agentName: { eq: record.name } }} search={{ agent: record.name }} hide="agent" />
          <HistorySection liveRevisionId={record.liveRevisionId ?? null} revisions={record.revisions} />
          {isEditing ? (
            <AgentEditorDialog
              open
              onOpenChange={setIsEditing}
              agent={{ id: record.id, name: record.name, document: (live ?? newest)?.document ?? null }}
            />
          ) : null}
        </>
      }
    />
  );
}
