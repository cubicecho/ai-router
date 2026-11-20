import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { OverridePoliciesDocument, SetAgentOverridePolicyDocument } from '@/__generated__/graphql';
import { SelectField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { Pencil } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { rulesOf, summaryOf } from '@/policies/rules';

/** The policy an agent has, as its page reads it. */
export interface AgentPolicy {
  id: string;
  name: string;
  description: string;
}

/** What the section is given. */
export interface AgentPolicySectionProps {
  agentId: string;
  /** Its policy, or null when the read could not reach it. */
  policy: AgentPolicy | null;
}

/** What the dialog that chooses an agent's policy is given. */
interface ChoosePolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  /** The policy it has now. */
  currentId: string;
}

/** Chooses an agent's override policy from the ones an admin has written. */
function ChoosePolicyDialog({ open, onOpenChange, agentId, currentId }: ChoosePolicyDialogProps) {
  const queryClient = useQueryClient();
  const policies = useQuery({
    queryKey: ['policies'],
    queryFn: () => request(OverridePoliciesDocument),
    enabled: open,
  });
  const choose = useMutation({
    mutationFn: (policyId: string) => request(SetAgentOverridePolicyDocument, { id: agentId, policyId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ queryKey: ['policies'] });
      onOpenChange(false);
    },
  });
  const form = useAppForm({
    defaultValues: { policyId: currentId },
    onSubmit: ({ value }) => choose.mutateAsync(value.policyId),
  });
  const rows = policies.data?.overridePolicies ?? [];
  const options = rows.map((policy) => ({ value: policy.id, label: policy.name }));

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title="Choose its override policy"
      description="What apps may add to or set on its runs, from their next request. Admins write the policies."
      loading={policies.isPending}
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <FormElement onSubmit={() => form.handleSubmit()} className={className}>
            {parts}
          </FormElement>
        </form.AppForm>
      )}
      contentSlot={
        <>
          <SelectField form={form} name="policyId" label="Policy" options={options} />
          <form.Subscribe selector={(state) => state.values.policyId}>
            {(policyId) => {
              const chosen = rows.find((policy) => policy.id === policyId);
              return chosen === undefined ? null : (
                <p className="text-foreground/70 text-sm">
                  {[chosen.description, summaryOf(rulesOf(chosen.rules))].filter((part) => part !== '').join(' ')}
                </p>
              );
            }}
          </form.Subscribe>
        </>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton requireChanges content="Save changes" />
        </>
      )}
    />
  );
}

/** Which override policy an agent's runs are checked against, and a way to choose another. */
export function AgentPolicySection({ agentId, policy }: AgentPolicySectionProps) {
  const [isChoosing, setIsChoosing] = useState(false);
  if (policy === null) {
    return null;
  }

  return (
    <Section
      title="Override policy"
      description="What apps may add to or set on its runs. It is the router's, not part of the document."
      actionSlot={
        <Button
          variant="outline"
          size="sm"
          iconSlot={<Pencil />}
          onClick={() => setIsChoosing(true)}
          content="Change"
        />
      }
      contentSlot={
        <>
          <PropertyList
            contentSlot={
              <PropertyRow
                label="Policy"
                value={
                  // The name alone is an identifier: the hint under it is prose.
                  <Link to="/policies" className="font-mono underline decoration-foreground/30 underline-offset-4">
                    {policy.name}
                  </Link>
                }
                hint={policy.description === '' ? undefined : policy.description}
              />
            }
          />
          {isChoosing ? (
            <ChoosePolicyDialog open onOpenChange={setIsChoosing} agentId={agentId} currentId={policy.id} />
          ) : null}
        </>
      }
    />
  );
}
