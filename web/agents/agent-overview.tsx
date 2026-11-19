import { Link } from '@tanstack/react-router';
import type { AgentQuery } from '@/__generated__/graphql';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { CopyButton } from '@/components/ui/copy-button';
import { RotateCcwClock } from '@/components/ui/icons';
import { AgentPolicySection } from './agent-policy-section';
import { Findings } from './findings';
import { whoOf } from './revisions';
import { describeServers, describeTaskModel, documentText, factsOf, stringsOf, whenOf } from './shapes';

/** One agent as its page reads it. */
export type AgentRecord = NonNullable<AgentQuery['agent']>;

/** What the overview is given. */
export interface AgentOverviewProps {
  agent: AgentRecord;
}

/**
 * Shows the servers an agent names, one badge each, or what naming none or leaving them out means.
 *
 * @param servers - `tools.servers`, as `factsOf` reads it.
 * @returns The badges, or the words.
 */
function ServersValue({ servers }: { servers: readonly string[] | null }) {
  const hasNames = servers !== null && servers.length > 0;
  if (hasNames === false) {
    return describeServers(servers);
  }
  return (
    <span className="flex flex-wrap gap-1">
      {servers.map((server) => (
        <Badge key={server} variant="outline" className="font-mono">
          {server}
        </Badge>
      ))}
    </span>
  );
}

/** The live revision of an agent: its name, model, MCP Servers and side tasks, and the document itself. */
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
          live === null ? undefined : `Revision ${live.number}, saved by ${whoOf(live)}, ${whenOf(live.createdAt)}.`
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
                    <PropertyRow
                      label="MCP Servers"
                      value={<ServersValue servers={facts.servers} />}
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
              </>
            }
          />
        }
      />
      <AgentPolicySection agentId={agent.id} policy={agent.overridePolicy ?? null} />
      {live === null || text === null ? null : (
        <Section
          title="Live document"
          description="The cubicecho.agent/1 document every run starts from, as it was saved."
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
