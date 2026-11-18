import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { AgentsDocument } from '@/__generated__/graphql';
import { AgentEditorDialog } from '@/agents/agent-editor-dialog';
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

/** Every agent the router runs for apps, each opening onto its document and history. */
export function AgentsRoute() {
  const [isAdding, setIsAdding] = useState(false);
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => request(AgentsDocument) });
  const rows = agents.data?.agents ?? [];
  const add = <Button variant="positive" iconSlot={<Plus />} onClick={() => setIsAdding(true)} content="New agent" />;

  return (
    <PageLayout
      width="prose"
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
                description="Paste a cubicecho.agent/1 document, or start from the one the editor offers."
                actionSlot={add}
              />
            }
          />
          <List
            label="Agents"
            contentSlot={rows.map((agent) => {
              const facts = factsOf(agent.liveRevision?.document);
              const title = facts.name ?? agent.name;
              return (
                <ListItem
                  key={agent.id}
                  title={title}
                  description={facts.description ?? undefined}
                  meta={
                    <span className="flex items-center gap-2">
                      {title === agent.name ? null : (
                        <span className="font-mono text-foreground/60 text-xs">{agent.name}</span>
                      )}
                      {agent.liveRevisionId === null ? <Badge variant="warning-soft">Can't run</Badge> : null}
                    </span>
                  }
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
