import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { AgentsDocument, type AgentsQuery } from '@/__generated__/graphql';
import { AgentEditorDialog } from '@/agents/agent-editor-dialog';
import { RevisionStanding, standingOf } from '@/agents/revisions';
import { factsOf } from '@/agents/shapes';
import { CardLayout } from '@/components/card-layout';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { RowMeta, rowNameFact } from '@/components/row-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Bot, Plus } from '@/components/ui/icons';
import { formatCount } from '@/lib/format';
import { request } from '@/lib/gql';

/** One agent as the list reads it. */
type AgentRow = AgentsQuery['agents'][number];

/** The facts at the end of an agent's row: its id, model and revision, where it is offered, and what needs a look. */
function AgentMeta({ agent }: { agent: AgentRow }) {
  const facts = factsOf(agent.liveRevision?.document);
  const liveRevisionId = agent.liveRevisionId ?? null;
  const drafts = agent.revisions.filter(
    (revision) => standingOf(revision, liveRevisionId) === RevisionStanding.Draft,
  ).length;
  return (
    <RowMeta
      facts={[
        rowNameFact(facts.name, agent.name),
        facts.model === null ? null : (
          <span key="model" className="font-mono">
            {facts.model}
          </span>
        ),
        agent.liveRevision === null ? null : `Revision ${agent.liveRevision.number}`,
        agent.workspaces.length === 0 ? null : `In ${formatCount(agent.workspaces.length, 'workspace', 'workspaces')}`,
      ]}
      badgesSlot={
        <>
          {drafts === 0 ? null : <Badge variant="info-soft">{formatCount(drafts, 'draft', 'drafts')}</Badge>}
          {liveRevisionId === null ? <Badge variant="warning-soft">Can't run</Badge> : null}
          {agent.workspaces.length === 0 ? <Badge variant="warning-soft">In no workspace</Badge> : null}
        </>
      }
    />
  );
}

/** Every agent the router runs for apps, each opening onto its document and history. */
export function AgentsRoute() {
  const [isAdding, setIsAdding] = useState(false);
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => request(AgentsDocument) });
  const rows = agents.data?.agents ?? [];
  const add = <Button variant="positive" iconSlot={<Plus />} onClick={() => setIsAdding(true)} content="New agent" />;

  return (
    <PageLayout
      width="page"
      title="Agents"
      description="A model, a prompt and tools, defined once. An app picks one as its model, by its name."
      actionSlot={rows.length > 0 ? add : undefined}
      contentSlot={
        <>
          <LoadState
            query={agents}
            what="the agents"
            count={rows.length}
            emptySlot={
              <EmptyState
                iconSlot={<Bot />}
                title="No agents yet"
                description="Paste a cubicecho.agent/2 document, or start from the one the editor offers."
                actionSlot={add}
              />
            }
          />
          {rows.length > 0 ? (
            <CardLayout
              level={2}
              title="All agents"
              contentSlot={
                <List
                  label="Agents"
                  contentSlot={rows.map((agent) => {
                    const facts = factsOf(agent.liveRevision?.document);
                    return (
                      <ListItem
                        key={agent.id}
                        title={facts.name ?? agent.name}
                        description={facts.description ?? undefined}
                        meta={<AgentMeta agent={agent} />}
                        linkSlot={<Link to="/agents/$agentId" params={{ agentId: agent.id }} />}
                      />
                    );
                  })}
                />
              }
            />
          ) : null}
          {/* Mounted only while open, so each new agent starts from the starter document. */}
          {isAdding ? <AgentEditorDialog open onOpenChange={setIsAdding} agent={null} /> : null}
        </>
      }
    />
  );
}
