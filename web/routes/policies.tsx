import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  DeleteOverridePolicyDocument,
  MeDocument,
  OverridePoliciesDocument,
  type OverridePolicyFieldsFragment,
} from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Pencil, Plus } from '@/components/ui/icons';
import { countOf } from '@/lib/format';
import { request } from '@/lib/gql';
import { Role } from '@/lib/roles';
import { PolicyDialog } from '@/policies/policy-dialog';
import { rulesOf, summaryOf } from '@/policies/rules';

/** Which dialog is open: none, a new policy, or one being edited. */
type Editing = { kind: 'closed' } | { kind: 'new' } | { kind: 'edit'; policy: OverridePolicyFieldsFragment };

/**
 * Says which agents use a policy.
 *
 * @param policy - The policy.
 * @returns Such as "Used by helper and 2 more", or "Used by no agent".
 */
function usedBy(policy: OverridePolicyFieldsFragment): string {
  const [first, ...rest] = policy.agents;
  if (first === undefined) {
    return 'Used by no agent';
  }
  return rest.length === 0
    ? `Used by ${first.name}`
    : `Used by ${first.name} and ${countOf(rest.length, 'more', 'more')}`;
}

/** Every override policy: what apps may change on an agent's runs. Every user reads them; admins write them. */
export function PoliciesRoute() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Editing>({ kind: 'closed' });
  const policies = useQuery({ queryKey: ['policies'], queryFn: () => request(OverridePoliciesDocument) });
  const me = useQuery({ queryKey: ['me'], queryFn: () => request(MeDocument) });
  const remove = useMutation({
    mutationFn: (id: string) => request(DeleteOverridePolicyDocument, { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['policies'] }),
  });
  const rows = policies.data?.overridePolicies ?? [];
  const isAdmin = me.data?.me.role === Role.Admin;
  const knownFields = [...new Set(rows.flatMap((policy) => rulesOf(policy.rules).sampling))];
  const close = (open: boolean) => {
    if (open === false) {
      setEditing({ kind: 'closed' });
    }
  };

  return (
    <PageLayout
      width="page"
      title="Override policies"
      description="What an app may add to or set on an agent's runs. Every agent has one, chosen on its page. A request that needs more is refused."
      actionSlot={
        isAdmin ? (
          <Button
            variant="positive"
            iconSlot={<Plus />}
            onClick={() => setEditing({ kind: 'new' })}
            content="New policy"
          />
        ) : undefined
      }
      contentSlot={
        <>
          <LoadState query={policies} what="the override policies" count={rows.length} />
          <List
            label="Override policies"
            contentSlot={rows.map((policy) => {
              const { isDefault } = policy;
              const isInUse = policy.agents.length > 0;
              return (
                <ListItem
                  key={policy.id}
                  title={policy.name}
                  titleClassName="font-mono"
                  description={[policy.description, summaryOf(rulesOf(policy.rules))]
                    .filter((part) => part !== '')
                    .join(' ')}
                  meta={
                    <span className="flex items-center gap-2">
                      {isDefault ? <Badge variant="secondary">Default</Badge> : null}
                      <span className="text-foreground/60 text-xs">{usedBy(policy)}</span>
                    </span>
                  }
                  actionSlot={
                    isAdmin ? (
                      <span className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="icon-sm"
                          iconSlot={<Pencil />}
                          aria-label={`Edit ${policy.name}`}
                          onClick={() => setEditing({ kind: 'edit', policy })}
                        />
                        {isDefault || isInUse ? null : (
                          <ConfirmButton
                            size="sm"
                            title={`Delete ${policy.name}?`}
                            description="No agent uses it, so nothing changes for any app. It can't be brought back."
                            onConfirm={() => remove.mutate(policy.id)}
                            content="Delete"
                          />
                        )}
                      </span>
                    ) : undefined
                  }
                />
              );
            })}
          />
          {editing.kind === 'closed' ? null : (
            <PolicyDialog
              open
              onOpenChange={close}
              policy={editing.kind === 'edit' ? editing.policy : null}
              knownFields={knownFields}
            />
          )}
        </>
      }
    />
  );
}
