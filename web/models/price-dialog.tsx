import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ModelPriceInput, SetModelPriceDocument } from '@/__generated__/graphql';
import { NumberField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { FieldRow } from '@/components/field-row';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';
import type { Price } from './cost';

/** What a price box says when it is empty. */
const NEEDS_PRICE = 'Give a price; 0 for free.';

/** What the price dialog is given. */
export interface PriceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  /** The model as an agent names it, for the title. */
  modelId: string;
  /** The model's id at the provider. */
  model: string;
  /** Its price now; null for none. */
  price: Price | null;
}

/**
 * Sets or clears what one of a provider's models costs, for usage to show.
 *
 * @param props - The provider's model, its price now, and whether the dialog is open.
 * @returns The dialog.
 */
export function PriceDialog({ open, onOpenChange, providerId, modelId, model, price }: PriceDialogProps) {
  const queryClient = useQueryClient();
  const setPrice = useMutation({
    mutationFn: (next: ModelPriceInput | null) => request(SetModelPriceDocument, { providerId, model, price: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['prices'] });
      onOpenChange(false);
    },
  });
  const form = useAppForm({
    defaultValues: {
      inputPerMillion: price?.inputPerMillion ?? (null as number | null),
      outputPerMillion: price?.outputPerMillion ?? (null as number | null),
    },
    onSubmit: ({ value }) =>
      setPrice.mutateAsync({
        inputPerMillion: value.inputPerMillion ?? 0,
        outputPerMillion: value.outputPerMillion ?? 0,
      }),
  });
  const required = ({ value }: { value: number | null }) => (value === null ? NEEDS_PRICE : undefined);

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`${modelId}'s price`}
      description="What a million tokens cost, in whatever currency you use for every price. Usage shows its cost at the prices entered now. A call through a pool with a price of its own costs the pool's."
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <FormElement onSubmit={() => form.handleSubmit()} className={className}>
            {parts}
          </FormElement>
        </form.AppForm>
      )}
      contentSlot={
        <FieldRow
          contentSlot={
            <>
              <NumberField
                form={form}
                name="inputPerMillion"
                label="Per million tokens in"
                min={0}
                step={0.01}
                required
                validators={{ onChange: required }}
              />
              <NumberField
                form={form}
                name="outputPerMillion"
                label="Per million tokens out"
                min={0}
                step={0.01}
                required
                validators={{ onChange: required }}
              />
            </>
          }
        />
      }
      footerActionsSlot={(close) => (
        <>
          {price === null ? null : (
            <Button
              variant="destructive-outline"
              loading={setPrice.isPending && setPrice.variables === null}
              onClick={() => setPrice.mutate(null)}
              content="Clear price"
            />
          )}
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton content="Save price" />
        </>
      )}
    />
  );
}
