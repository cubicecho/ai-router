import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CreateOverridePolicyDocument,
  type OverridePolicyFieldsFragment,
  UpdateOverridePolicyDocument,
} from '@/__generated__/graphql';
import { ComboboxField, InputField, SwitchField, TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';
import { NAME_HINT, NAME_PATTERN } from '@/models/names';
import { type PolicyRules, rulesOf } from './rules';

/** What the policy dialog is given. */
export interface PolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The policy to edit, or null to make one. */
  policy: OverridePolicyFieldsFragment | null;
  /** The sampling fields any policy names, offered as suggestions. */
  knownFields: readonly string[];
}

/** Makes or edits an override policy: its name, what it is for, and what it lets an app change. Admin only. */
export function PolicyDialog({ open, onOpenChange, policy, knownFields }: PolicyDialogProps) {
  const queryClient = useQueryClient();
  const isEdit = policy !== null;
  const rules = rulesOf(policy?.rules);
  const save = useMutation({
    mutationFn: async (values: { name: string; description: string; rules: PolicyRules }) => {
      if (policy === null) {
        return (await request(CreateOverridePolicyDocument, { values })).createOverridePolicy;
      }
      return (await request(UpdateOverridePolicyDocument, { id: policy.id, values })).updateOverridePolicy;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['policies'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      onOpenChange(false);
    },
  });
  const form = useAppForm({
    defaultValues: {
      name: policy?.name ?? '',
      description: policy?.description ?? '',
      narrowServers: rules.narrowServers,
      responseFormat: rules.responseFormat,
      sampling: rules.sampling,
    },
    onSubmit: ({ value }) =>
      save.mutateAsync({
        name: value.name.trim(),
        description: value.description.trim(),
        rules: {
          narrowServers: value.narrowServers,
          responseFormat: value.responseFormat,
          sampling: [...value.sampling],
        },
      }),
  });
  const fieldOptions = [...new Set([...knownFields, ...rules.sampling])]
    .sort()
    .map((field) => ({ value: field, label: field }));

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${policy.name}` : 'New override policy'}
      description="What an app may set on an agent's runs. A request that needs anything else is refused, never trimmed. No policy changes an agent's model or its prompt: an app's parts and system messages always come after the agent's, as its parts allow."
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
          <InputField
            form={form}
            name="name"
            label="Name"
            description={NAME_HINT}
            required
            validators={{ onChange: ({ value }) => (NAME_PATTERN.test(value.trim()) ? undefined : NAME_HINT) }}
          />
          <TextareaField
            form={form}
            name="description"
            label="Description"
            description="What it is for, for the people choosing it for an agent."
            rows={2}
          />
          <SwitchField
            form={form}
            name="narrowServers"
            label="Narrower servers"
            description="A request may use fewer of the agent's MCP servers. It never adds one."
          />
          <SwitchField
            form={form}
            name="responseFormat"
            label="response_format"
            description="A request may ask for JSON."
          />
          <ComboboxField
            form={form}
            name="sampling"
            label="Sampling fields"
            description="The request fields an app may set, as OpenAI names them. Type a name to add one."
            multiple
            freeText
            options={fieldOptions}
            placeholder="None"
          />
        </>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton requireChanges={isEdit} content={isEdit ? 'Save changes' : 'Create policy'} />
        </>
      )}
    />
  );
}
