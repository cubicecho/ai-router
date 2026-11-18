import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import {
  DeleteProviderDocument,
  MeDocument,
  ProviderDocument,
  ProviderModelsDocument,
  UsageByProviderDocument,
} from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadError, LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { ArrowLeft, KeyRound, Pencil, RefreshCw } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { Role } from '@/lib/roles';
import { ApiKeyDialog } from '@/models/api-key-dialog';
import { headersOf } from '@/models/headers';
import { ProviderDialog } from '@/models/provider-dialog';
import { UsageSection } from '@/models/usage-section';

/** One provider: where it is, its key, what it serves now, and what it has been used for. */
export function ProviderRoute() {
  const { providerId } = useParams({ from: '/app/providers/$providerId' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [isSettingKey, setIsSettingKey] = useState(false);
  const [refresh, setRefresh] = useState(false);
  const me = useQuery({ queryKey: ['me'], queryFn: () => request(MeDocument) });
  const provider = useQuery({
    queryKey: ['providers', providerId],
    queryFn: () => request(ProviderDocument, { id: providerId }),
  });
  const models = useQuery({
    queryKey: ['providers', providerId, 'models'],
    queryFn: () => request(ProviderModelsDocument, { id: providerId, refresh }),
    meta: { quiet: true },
  });
  const usage = useQuery({
    queryKey: ['usage', 'provider', providerId],
    queryFn: () => request(UsageByProviderDocument, { providerId }),
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
  const modelRows = models.data?.providerModels ?? [];
  return (
    <PageLayout
      title={record.displayName ?? record.name}
      description={record.description === '' ? undefined : record.description}
      backSlot={back}
      width="prose"
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
      contentSlot={
        <>
          <PropertyList
            contentSlot={
              <>
                <PropertyRow
                  label="Name"
                  value={record.name}
                  valueClassName="font-mono"
                  hint="Agents name its models as name/model."
                />
                <PropertyRow label="Base URL" value={record.baseUrl} valueClassName="font-mono" />
                <PropertyRow label="Takes calls" value={record.enabled ? 'Yes' : 'No'} />
                <PropertyRow
                  label="API key"
                  value={record.apiKeySet ? 'Set' : 'None'}
                  hint={isAdmin ? undefined : 'Only an admin can set it.'}
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
                {headers.map(([name, value]) => (
                  <PropertyRow key={name} label={name} value={value} valueClassName="font-mono" hint="Extra header" />
                ))}
              </>
            }
          />
          <Section
            title="Models"
            description="What it serves now, from its own model list."
            actionSlot={
              <Button
                variant="outline"
                size="sm"
                iconSlot={<RefreshCw />}
                loading={models.isFetching}
                onClick={() => {
                  setRefresh(true);
                  void models.refetch();
                }}
                content="Refresh"
              />
            }
            contentSlot={
              models.isError ? (
                <LoadError error={models.error} onRetry={models.refetch} what="its models" compact />
              ) : modelRows.length === 0 && models.isPending === false ? (
                <EmptyState compact title="It lists no models." />
              ) : (
                <List
                  label="Models"
                  contentSlot={modelRows.map((model) => (
                    <ListItem key={model.id} title={`${record.name}/${model.id}`} meta={model.ownedBy ?? undefined} />
                  ))}
                />
              )
            }
          />
          <UsageSection rows={usage.data?.usageCounts ?? []} groupBy={(row) => row.model} groupLabel="Model" />
          <ProviderDialog open={isEditing} onOpenChange={setIsEditing} provider={record} />
          {isAdmin ? <ApiKeyDialog open={isSettingKey} onOpenChange={setIsSettingKey} provider={record} /> : null}
        </>
      }
    />
  );
}
