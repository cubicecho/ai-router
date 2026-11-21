import { Link } from '@tanstack/react-router';
import type { AgentQuery } from '@/__generated__/graphql';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { CopyButton } from '@/components/ui/copy-button';
import { RotateCcwClock } from '@/components/ui/icons';
import { formatDateTime } from '@/lib/format';
import { Findings } from './findings';
import { LockedFieldsSection } from './locked-fields-section';
import { whoOf } from './revisions';
import { describeTaskModel, documentText, factsOf, stringsOf } from './shapes';

/** One agent as its page reads it. */
export type AgentRecord = NonNullable<AgentQuery['agent']>;

/** What the overview is given. */
export interface AgentOverviewProps {
  agent: AgentRecord;
}

/** The live revision of an agent: its name, model and side tasks, and the document itself. Its MCP servers are each workspace's to choose. */
export function AgentOverview({ agent }: AgentOverviewProps) {
  const live = agent.liveRevision ?? null;
  const facts = factsOf(live?.document);
  const text = live === null ? null : documentText(live.document);

  return (
    <>
      {live === null ? (
        <Alert
          variant="warning"
          title="It can't run"
          description="No revision is live, so apps that ask for it are refused. Make one live from its history."
          actionSlot={
            <Button
              variant="outline"
              size="sm"
              iconSlot={<RotateCcwClock />}
              linkSlot={
                <Link to="/agents/$agentId" params={{ agentId: agent.id }} search={{ tab: 'history' }} replace />
              }
              content="Open history"
            />
          }
        />
      ) : (
        <Findings findings={{ errors: [], warnings: stringsOf(live.warnings) }} />
      )}
      <Section
        title="Live revision"
        description={
          live === null
            ? undefined
            : `Revision ${live.number}, saved by ${whoOf(live)}, ${formatDateTime(live.createdAt)}.`
        }
        contentSlot={
          <PropertyList
            contentSlot={
              <>
                <PropertyRow
                  label="Name"
                  value={agent.name}
                  valueClassName="font-mono"
                  hint="What an app sends as its model to run it. It never changes."
                  actionSlot={<CopyButton value={agent.name} label="Copy the name" />}
                />
                {live === null ? null : (
                  <>
                    <PropertyRow
                      label="Model"
                      value={facts.model ?? 'None named, so it cannot run'}
                      valueClassName={facts.model === null ? undefined : 'font-mono'}
                      hint={facts.temperature === null ? undefined : `Temperature ${facts.temperature}`}
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
              </>
            }
          />
        }
      />
      {live === null ? null : <LockedFieldsSection key={live.id} agentId={agent.id} document={live.document} />}
      {live === null || text === null ? null : (
        <Section
          title="Live document"
          description="The cubicecho.agent/2 document every run starts from, as it was saved."
          contentSlot={
            <CodeBlock
              title={`${agent.name}.json`}
              language="json"
              content={text}
              actionSlot={<CopyButton value={text} label="Copy the document" />}
            />
          }
        />
      )}
    </>
  );
}
