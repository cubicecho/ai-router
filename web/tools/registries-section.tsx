import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DeleteRegistryDocument, RegistriesDocument, type RegistryFieldsFragment } from '@/__generated__/graphql';
import { CardLayout } from '@/components/card-layout';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { Button } from '@/components/ui/button';
import { Pencil, Plus } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { RegistryDialog } from './registry-dialog';

/** The registries servers are installed from: list, add, edit and delete. Untitled: its tab names it. */
export function RegistriesSection() {
  const queryClient = useQueryClient();
  // undefined is closed, null is adding, a registry is editing it.
  const [editing, setEditing] = useState<RegistryFieldsFragment | null | undefined>(undefined);
  const registries = useQuery({ queryKey: ['registries'], queryFn: () => request(RegistriesDocument) });
  const remove = useMutation({
    mutationFn: (id: string) => request(DeleteRegistryDocument, { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['registries'] }),
  });
  const rows = registries.data?.registries ?? [];
  const add = (
    <Button variant="positive" size="sm" iconSlot={<Plus />} onClick={() => setEditing(null)} content="New registry" />
  );

  return (
    <CardLayout
      level={2}
      description="Catalogues of MCP servers to install from. Installed servers keep working if one is deleted."
      actionSlot={rows.length > 0 ? add : undefined}
      contentSlot={
        <>
          <LoadState
            compact
            query={registries}
            what="the registries"
            count={rows.length}
            emptySlot={<EmptyState compact title="No registries yet." actionSlot={add} />}
          />
          <List
            label="Registries"
            contentSlot={rows.map((registry) => (
              <ListItem
                key={registry.id}
                title={registry.name}
                description={registry.url}
                actionSlot={
                  <>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label={`Edit ${registry.name}`}
                      iconSlot={<Pencil />}
                      onClick={() => setEditing(registry)}
                    />
                    <ConfirmButton
                      size="sm"
                      title={`Delete ${registry.name}?`}
                      description="You can no longer install from it here. Servers installed from it keep working."
                      onConfirm={() => remove.mutate(registry.id)}
                      content="Delete"
                    />
                  </>
                }
              />
            ))}
          />
          {editing === undefined ? null : (
            <RegistryDialog
              key={editing?.id ?? 'new'}
              open
              onOpenChange={(open) => (open ? undefined : setEditing(undefined))}
              registry={editing}
            />
          )}
        </>
      }
    />
  );
}
