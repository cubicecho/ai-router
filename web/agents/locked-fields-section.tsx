import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { SaveAgentDocument } from '@/__generated__/graphql';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { Check, Plus } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { SwitchField } from '@/components/ui/switch-field';
import { useToast } from '@/components/ui/toast';
import { request } from '@/lib/gql';
import { isRecord } from '@/lib/is-record';
import { fieldNameOf, listedFields, lockedFieldsOf, withLockedFields } from './locked-fields';

/** What the section is given. */
export interface LockedFieldsSectionProps {
  /** The agent's id. */
  agentId: string;
  /** Its live revision's document, as stored. */
  document: unknown;
}

/**
 * Says how a save changed the locked fields, for the revision's message.
 *
 * @param fields - The fields locked after the save.
 * @returns One line.
 */
function saveMessage(fields: readonly string[]): string {
  return fields.length === 0 ? 'Unlocked every request field.' : `Locked request fields: ${fields.join(', ')}.`;
}

/**
 * The request fields an app may not change for this agent. Every field is open unless locked here, and saving writes
 * a new revision of the document, which goes live as any person's save does.
 */
export function LockedFieldsSection({ agentId, document }: LockedFieldsSectionProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const saved = lockedFieldsOf(document);
  const [locked, setLocked] = useState<string[]>(saved);
  const [typed, setTyped] = useState('');
  const typedName = fieldNameOf(typed);
  const isChanged = locked.length !== saved.length || locked.some((field) => saved.includes(field) === false);

  const save = useMutation({
    mutationFn: async (fields: string[]) => {
      const base = isRecord(document) ? document : {};
      const { saveAgent } = await request(SaveAgentDocument, {
        id: agentId,
        document: withLockedFields(base, fields),
        message: saveMessage(fields),
      });
      return saveAgent;
    },
    onSuccess: async (revision) => {
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
      toast(
        `Saved revision ${revision.number}, and it is live. Runs hold apps to it from their next request.`,
        'positive',
      );
    },
  });

  /**
   * Locks or unlocks one field, until the next save.
   *
   * @param field - The field.
   * @param isLocked - Whether to lock it.
   */
  const toggle = (field: string, isLocked: boolean): void => {
    setLocked((current) => (isLocked ? [...current, field] : current.filter((name) => name !== field)));
  };

  /** Locks the typed field, and clears the box. */
  const addTyped = (): void => {
    if (typedName === null) {
      return;
    }
    if (locked.includes(typedName) === false) {
      setLocked((current) => [...current, typedName]);
    }
    setTyped('');
  };

  return (
    <Section
      title="Request fields"
      description="An app may set any request field (temperature, max_tokens, seed, a provider's own field) and it reaches this agent's model, unless it is locked here. A request that sets a locked field is refused, or the field is dropped and named if an admin set the router to ignore such fields."
      actionSlot={
        <Button
          variant="positive"
          size="sm"
          iconSlot={<Check />}
          disabled={isChanged === false}
          loading={save.isPending}
          hint="Saves a new revision with these fields locked. It goes live at once."
          onClick={() => save.mutate(locked)}
          content="Save"
        />
      }
      contentSlot={
        <div className="flex flex-col gap-3">
          {listedFields(locked).map((field) => (
            <SwitchField
              key={field}
              id={`locked-${field}`}
              label={field}
              labelClassName="font-mono"
              checked={locked.includes(field)}
              onCheckedChange={(isLocked) => toggle(field, isLocked)}
              disabled={save.isPending}
            />
          ))}
          <div className="flex items-center gap-2">
            <Input
              aria-label="Another field to lock"
              placeholder="Another field to lock, by its wire name, such as logit_bias"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
            <Button
              variant="positive-outline"
              iconSlot={<Plus />}
              disabled={typedName === null || save.isPending}
              onClick={addTyped}
              content="Lock"
            />
          </div>
        </div>
      }
    />
  );
}
