import { useQuery } from '@tanstack/react-query';
import { UsageByAgentDocument } from '@/__generated__/graphql';
import { LoadError, RowSkeleton } from '@/components/load-state';
import { request } from '@/lib/gql';
import { UsageSection } from '@/models/usage-section';

/** What stands in for the workspace of calls no workspace made, such as a person trying the agent in the UI. */
const NO_WORKSPACE = 'No workspace';

/** What the section is given. */
export interface AgentUsageSectionProps {
  agentId: string;
}

/** The calls and tokens an agent's runs spent, by the workspace whose apps ran it and by day. */
export function AgentUsageSection({ agentId }: AgentUsageSectionProps) {
  const usage = useQuery({
    queryKey: ['usage', 'agent', agentId],
    queryFn: () => request(UsageByAgentDocument, { agentId }),
  });
  if (usage.isError) {
    return <LoadError error={usage.error} onRetry={usage.refetch} what="its usage" />;
  }
  if (usage.isPending) {
    return <RowSkeleton />;
  }
  return (
    <UsageSection
      rows={usage.data.usageCounts}
      groupBy={(row) => row.workspaceName ?? NO_WORKSPACE}
      groupLabel="Workspace"
    />
  );
}
