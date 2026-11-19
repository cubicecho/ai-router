import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { DeleteProviderDocument, MeDocument, ProviderDocument, UsageByProviderDocument } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { LoadError, LoadState, RowSkeleton } from '@/components/load-state';
import { PageLayout, titleColumn } from '@/components/page-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { ArrowLeft, KeyRound, Pencil } from '@/components/ui/icons';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { request } from '@/lib/gql';
import { Role } from '@/lib/roles';
import { openTab } from '@/lib/tab-search';
import { cn } from '@/lib/utils';
import { ApiKeyDialog } from '@/models/api-key-dialog';
import { headersOf } from '@/models/headers';
import { ModelsSection } from '@/models/models-section';
import { ProviderDialog } from '@/models/provider-dialog';
import { PROVIDER_TABS, type ProviderTab, validateProviderSearch } from '@/models/tabs';
import { UsageSection } from '@/models/usage-section';

/** What each tab is called. */
const TAB_LABELS = {
  overview: 'Overview',
  models: 'Models',
  usage: 'Usage',
} as const satisfies Record<ProviderTab, string>;

/** What one provider has been used for, by model and by day. Asked for only once its tab is open. */
function ProviderUsage({ providerId }: { providerId: string }) {
  const usage = useQuery({
    queryKey: ['usage', 'provider', providerId],
    queryFn: () => request(UsageByProviderDocument, { providerId }),
  });
  if (usage.isError) {
    return <LoadError error={usage.error} onRetry={usage.refetch} what="its usage" />;
  }
  if (usage.isPending) {
    return <RowSkeleton rows={3} />;
  }
  return <UsageSection rows={usage.data.usageCounts} groupBy={(row) => row.model} groupLabel="Model" />;
}

/** One provider, in tabs: where it is and its key, what it serves now, and what it has been used for. */
export function ProviderRoute() {
  const { providerId } = useParams({ from: '/app/providers/$providerId' });
  const search = useSearch({ from: '/app/providers/$providerId' });
  const navigate = useNavigate({ from: '/providers/$providerId' });
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [isSettingKey, setIsSettingKey] = useState(false);
  const me = useQuery({ queryKey: ['me'], queryFn: () => request(MeDocument) });
  const provider = useQuery({
    queryKey: ['providers', providerId],
    queryFn: () => request(ProviderDocument, { id: providerId }),
  });
  const remove = useMutation({
    mutationFn: () => request(DeleteProviderDocument, { id: providerId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['providers'] });
      void navigate({ to: '/providers' });
    },
  });
  const record = provider.data?.provider ?? undefined;
  const isAdmin = me.data?.me.role === Role.Admin;
  const back = (
    <Button
      variant="outline"
      size="sm"
      iconSlot={<ArrowLeft />}
      linkSlot={<Link to="/providers" />}
      content="Providers"
    />
  );

  if (record === undefined) {
    return (
      <PageLayout
        title="Provider"
        backSlot={back}
        width="page"
        loading={provider.isPending}
        contentSlot={
          <LoadState
            query={provider}
            what="this provider"
            record={record}
            notFoundLabel="Provider not found"
            level={2}
          />
        }
      />
    );
  }

  const headers = Object.entries(headersOf(record.headers));
  return (
    <Tabs
      value={openTab(PROVIDER_TABS, search)}
      onValueChange={(tab) => void navigate({ search: validateProviderSearch({ tab }), replace: true })}
      className="h-full"
    >
      <PageLayout
        title={
          <span className="flex items-center gap-2">
            {record.displayName ?? record.name}
            {record.enabled ? null : <Badge variant="outline">Off</Badge>}
          </span>
        }
        description={record.description === '' ? undefined : record.description}
        backSlot={back}
        width="page"
        actionSlot={
          <>
            <Button variant="outline" iconSlot={<Pencil />} onClick={() => setIsEditing(true)} content="Edit" />
            <ConfirmButton
              title={`Delete ${record.name}?`}
              description="Agents naming its models stop finding them, and it leaves every pool. Its usage is kept."
              requireText={record.name}
              onConfirm={() => remove.mutate()}
              content="Delete"
            />
          </>
        }
        headerBarSlot={
          <div className={cn(titleColumn('page'), 'pb-3')}>
            <TabsList aria-label="Provider">
              {PROVIDER_TABS.map((tab) => (
                <TabsTrigger key={tab} value={tab}>
                  {TAB_LABELS[tab]}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        }
        contentSlot={
          <>
            <TabsContent value="overview" className="flex flex-col gap-4">
              <PropertyList
                contentSlot={
                  <>
                    <PropertyRow
                      label="Name"
                      value={record.name}
                      valueClassName="font-mono"
                      hint="Agents name its models as name/model."
                      actionSlot={<CopyButton value={record.name} label="Copy name" />}
                    />
                    <PropertyRow
                      label="Base URL"
                      value={record.baseUrl}
                      valueClassName="font-mono break-all"
                      actionSlot={<CopyButton value={record.baseUrl} label="Copy base URL" />}
                    />
                    <PropertyRow label="Takes calls" value={record.enabled ? 'Yes' : 'No'} />
                    <PropertyRow
                      label="API key"
                      value={
                        record.apiKeySet ? (
                          <Badge variant="positive-soft">Set</Badge>
                        ) : (
                          <Badge variant="outline">None</Badge>
                        )
                      }
                      hint={isAdmin ? 'Kept by the router and never shown again.' : 'Only an admin can set it.'}
                      actionSlot={
                        isAdmin ? (
                          <Button
                            variant="outline"
                            size="sm"
                            iconSlot={<KeyRound />}
                            onClick={() => setIsSettingKey(true)}
                            content={record.apiKeySet ? 'Change' : 'Set'}
                          />
                        ) : undefined
                      }
                    />
                  </>
                }
              />
              <Section
                title="Headers"
                description="Sent with every call to it, beside the key."
                contentSlot={
                  headers.length === 0 ? (
                    <EmptyState compact title="No extra headers." />
                  ) : (
                    <PropertyList
                      contentSlot={headers.map(([name, value]) => (
                        <PropertyRow
                          key={name}
                          label={name}
                          labelClassName="font-mono"
                          value={value}
                          valueClassName="font-mono break-all"
                        />
                      ))}
                    />
                  )
                }
              />
            </TabsContent>
            <TabsContent value="models">
              <ModelsSection providerId={record.id} providerName={record.name} />
            </TabsContent>
            <TabsContent value="usage">
              <ProviderUsage providerId={record.id} />
            </TabsContent>
            <ProviderDialog open={isEditing} onOpenChange={setIsEditing} provider={record} />
            {isAdmin ? <ApiKeyDialog open={isSettingKey} onOpenChange={setIsSettingKey} provider={record} /> : null}
          </>
        }
      />
    </Tabs>
  );
}
