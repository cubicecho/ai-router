import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type PoolFieldsFragment, SetPoolTargetsDocument } from '@/__generated__/graphql';
import { Combobox } from '@/components/combobox';
import { DialogLayout } from '@/components/dialog-layout';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp, Plus, Trash2 } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { request } from '@/lib/gql';

/** One target as the dialog holds it. */
interface DraftTarget {
  providerId: string;
  providerName: string;
  model: string;
}

/** What the targets dialog is given. */
export interface TargetsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pool: PoolFieldsFragment;
  /** Every provider a target may name. */
  providers: readonly { id: string; name: string }[];
}

/** Edits a pool's targets as one ordered list, saved whole. */
export function TargetsDialog({ open, onOpenChange, pool, providers }: TargetsDialogProps) {
  const queryClient = useQueryClient();
  const initial = (): DraftTarget[] =>
    pool.targets.map((target) => ({
      providerId: target.provider?.id ?? '',
      providerName: target.provider?.name ?? '',
      model: target.model,
    }));
  const [targets, setTargets] = useState<DraftTarget[]>(initial);
  const [providerId, setProviderId] = useState<string | undefined>(undefined);
  const [model, setModel] = useState('');
  const save = useMutation({
    mutationFn: () =>
      request(SetPoolTargetsDocument, {
        poolId: pool.id,
        targets: targets.map((target) => ({ providerId: target.providerId, model: target.model })),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pools'] });
      onOpenChange(false);
    },
  });
  const chosen = providers.find((provider) => provider.id === providerId);
  const isDuplicate = targets.some((target) => target.providerId === providerId && target.model === model.trim());
  const canAdd = chosen !== undefined && model.trim() !== '' && isDuplicate === false;
  const add = () => {
    if (chosen === undefined) {
      return;
    }
    setTargets([...targets, { providerId: chosen.id, providerName: chosen.name, model: model.trim() }]);
    setModel('');
  };
  const move = (from: number, to: number) => {
    const next = [...targets];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) {
      next.splice(to, 0, moved);
      setTargets(next);
    }
  };
  const close = (next: boolean) => {
    if (next === false) {
      setTargets(initial());
    }
    onOpenChange(next);
  };

  return (
    <DialogLayout
      open={open}
      onOpenChange={close}
      title={`${pool.name}'s targets`}
      description="Where a call to this pool may go: a provider and the model's id there. Order breaks ties."
      contentSlot={
        <div className="grid gap-4">
          {targets.length === 0 ? (
            <EmptyState compact title="No targets yet. Add one below." />
          ) : (
            <List
              label="Targets"
              contentSlot={targets.map((target, index) => (
                <ListItem
                  key={`${target.providerId}\n${target.model}`}
                  title={`${target.providerName}/${target.model}`}
                  actionSlot={
                    <>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label="Move up"
                        disabled={index === 0}
                        onClick={() => move(index, index - 1)}
                        iconSlot={<ChevronUp />}
                      />
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label="Move down"
                        disabled={index === targets.length - 1}
                        onClick={() => move(index, index + 1)}
                        iconSlot={<ChevronDown />}
                      />
                      <Button
                        variant="destructive-outline"
                        size="icon-sm"
                        aria-label="Remove"
                        onClick={() => setTargets(targets.filter((_, at) => at !== index))}
                        iconSlot={<Trash2 />}
                      />
                    </>
                  }
                />
              ))}
            />
          )}
          <div className="grid gap-2 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
            <Combobox
              aria-label="Provider"
              placeholder="Provider"
              options={providers.map((provider) => ({ value: provider.id, label: provider.name }))}
              value={providerId}
              onValueChange={setProviderId}
            />
            <Input
              aria-label="Model at the provider"
              placeholder="Model at the provider, such as qwen3:8b"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            <Button
              variant="info-outline"
              iconSlot={<Plus />}
              disabled={canAdd === false}
              onClick={add}
              content="Add"
            />
          </div>
        </div>
      }
      footerActionsSlot={(dismiss) => (
        <>
          <Button variant="outline" onClick={dismiss} content="Cancel" />
          <Button variant="positive" loading={save.isPending} onClick={() => save.mutate()} content="Save targets" />
        </>
      )}
    />
  );
}
