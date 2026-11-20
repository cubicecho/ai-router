import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { AgentsDocument, type AgentsQuery } from '@/__generated__/graphql';
import { AgentEditorDialog } from '@/agents/agent-editor-dialog';
import { RevisionStanding, standingOf } from '@/agents/revisions';
import { factsOf } from '@/agents/shapes';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Bot, Plus } from '@/components/ui/icons';
import { request } from '@/lib/gql';

/** One agent as the list reads it. */
type AgentRow = AgentsQuery['agents'][number];

/**
 * Says how many workspaces offer an agent.
 *
 * @param count - How many.
 * @returns Such as "In 2 workspaces", or "In no workspace".
 */
function describeOffers(count: number): string {
  if (count === 0) {
    return 'In no workspace';
  }
  return count === 1 ? 'In 1 workspace' : `In ${count} workspaces`;
}

/** The facts at the end of an agent's row: its id, model and revision, where it is offered, and what needs a look. */
function AgentMeta({ agent }: { agent: AgentRow }) {
  const facts = factsOf(agent.liveRevision?.document);
  const title = facts.name ?? agent.name;
  const liveRevisionId = agent.liveRevisionId ?? null;
  const drafts = agent.revisions.filter(
    (revision) => standingOf(revision, liveRevisionId) === RevisionStanding.Draft,
  ).length;
  return (
    <span className="flex items-center gap-4 text-foreground/60 text-xs">
      {title === agent.name ? null : <span className="font-mono">{agent.name}</span>}
      {facts.model === null ? null : <span className="font-mono">{facts.model}</span>}
      {agent.liveRevision === null ? null : <span className="tabular-nums">Revision {agent.liveRevision.number}</span>}
      <span>{describeOffers(agent.workspaces.length)}</span>
      {drafts === 0 ? null : <Badge variant="info-soft">{drafts === 1 ? '1 draft' : `${drafts} drafts`}</Badge>}
      {liveRevisionId === null ? <Badge variant="warning-soft">Can't run</Badge> : null}
    </span>
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
          {/* Mounted only while open, so each new agent starts from the starter document. */}
          {isAdding ? <AgentEditorDialog open onOpenChange={setIsAdding} agent={null} /> : null}
        </>
      }
    />
  );
}
