import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CreatePoolDocument,
  type PoolFieldsFragment,
  type PoolsAffinityEnum,
  type PoolsStrategyEnum,
  UpdatePoolDocument,
} from '@/__generated__/graphql';
import { InputField, NumberField, SelectField, SwitchField, TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { FieldRow } from '@/components/field-row';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';
import { NAME_HINT, NAME_PATTERN } from './names';

/** How a pool picks a target, as people read it. */
export const STRATEGIES: { value: PoolsStrategyEnum; label: string }[] = [
  { value: 'least_busy', label: 'Least busy' },
  { value: 'round_robin', label: 'In turn' },
  { value: 'random', label: 'At random' },
];

/** Whether a pool keeps a conversation on one target, as people read it. */
export const AFFINITIES: { value: PoolsAffinityEnum; label: string }[] = [
  { value: 'sticky', label: 'Keep a conversation on one target' },
  { value: 'none', label: 'Place every call on its own' },
];

/**
 * Finds a choice by its value.
 *
 * @typeParam T - The choice's value.
 * @param choices - The choices.
 * @param value - The value picked.
 * @returns The value, when it is one of the choices; otherwise the first.
 */
function choiceOf<T extends string>(choices: readonly { value: T }[], value: string): T {
  const found = choices.find((choice) => choice.value === value);
  const [first] = choices;
  if (found !== undefined) {
    return found.value;
  }
  if (first === undefined) {
    throw new Error('There are no choices to pick from.');
  }
  return first.value;
}

/** What the pool dialog is given. */
export interface PoolDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The pool to edit, or null to make one. */
  pool: PoolFieldsFragment | null;
  /** Called with the pool once it is saved. */
  onSaved?: (pool: PoolFieldsFragment) => void;
}

/** Makes or edits a pool: its name and how it picks a target. Its targets are edited on their own. */
export function PoolDialog({ open, onOpenChange, pool, onSaved }: PoolDialogProps) {
  const queryClient = useQueryClient();
  const isEdit = pool !== null;
  const save = useMutation({
    mutationFn: async (values: {
      name: string;
      displayName: string | null;
      description: string;
      enabled: boolean;
      strategy: PoolsStrategyEnum;
      affinity: PoolsAffinityEnum;
      maxLoadFactor: number | null;
      inputPricePerMillion: number | null;
      outputPricePerMillion: number | null;
    }) => {
      if (pool === null) {
        return (await request(CreatePoolDocument, { values })).createPool;
      }
      const { updatePool } = await request(UpdatePoolDocument, { id: pool.id, set: values });
      if (updatePool === null) {
        throw new Error('That pool is gone. Someone may have deleted it.');
      }
      return updatePool;
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['pools'] });
      onOpenChange(false);
      onSaved?.(saved);
    },
  });
  const form = useAppForm({
    defaultValues: {
      name: pool?.name ?? '',
      displayName: pool?.displayName ?? '',
      description: pool?.description ?? '',
      enabled: pool?.enabled ?? true,
      strategy: pool?.strategy ?? 'least_busy',
      affinity: pool?.affinity ?? 'sticky',
      maxLoadFactor: pool?.maxLoadFactor ?? (null as number | null),
      inputPricePerMillion: pool?.inputPricePerMillion ?? (null as number | null),
      outputPricePerMillion: pool?.outputPricePerMillion ?? (null as number | null),
    },
    onSubmit: ({ value }) =>
      save.mutateAsync({
        name: value.name.trim(),
        displayName: value.displayName.trim() === '' ? null : value.displayName.trim(),
        description: value.description,
        enabled: value.enabled,
        strategy: choiceOf(STRATEGIES, value.strategy),
        affinity: choiceOf(AFFINITIES, value.affinity),
        maxLoadFactor: value.maxLoadFactor,
        inputPricePerMillion: value.inputPricePerMillion,
        outputPricePerMillion: value.outputPricePerMillion,
      }),
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${pool.name}` : 'New pool'}
      description="One model name served by several targets, the router picking one for each call."
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
            description={
              isEdit
                ? `${NAME_HINT} Agents name the pool by it, so renaming breaks those that use the old name.`
                : `${NAME_HINT} Agents name the pool by it, as their model.`
            }
            required
            validators={{ onChange: ({ value }) => (NAME_PATTERN.test(value.trim()) ? undefined : NAME_HINT) }}
          />
          <InputField form={form} name="displayName" label="Display name" />
          <SelectField form={form} name="strategy" label="Picks a target" options={STRATEGIES} />
          <SelectField form={form} name="affinity" label="Conversations" options={AFFINITIES} />
          <NumberField
            form={form}
            name="maxLoadFactor"
            label="Load factor"
            description="A kept conversation moves on once its target holds more than this times the average. Empty is off; 1.25 is a good start."
            min={1}
            step={0.05}
          />
          <FieldRow
            contentSlot={
              <>
                <NumberField
                  form={form}
                  name="inputPricePerMillion"
                  label="Price per million tokens in"
                  description="Both empty: a call costs its target's own price."
                  min={0}
                  step={0.01}
                />
                <NumberField
                  form={form}
                  name="outputPricePerMillion"
                  label="Price per million tokens out"
                  description="Set both or neither, in the currency every price uses."
                  min={0}
                  step={0.01}
                />
              </>
            }
          />
          <TextareaField form={form} name="description" label="Description" rows={2} />
          <SwitchField
            form={form}
            name="enabled"
            label="Takes calls"
            description="Off, agents naming it are refused."
          />
        </>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton requireChanges={isEdit} content={isEdit ? 'Save changes' : 'Create pool'} />
        </>
      )}
    />
  );
}
