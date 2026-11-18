import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CheckAgentDocument, CreateAgentDocument, SaveAgentDocument } from '@/__generated__/graphql';
import { InputField, TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { ScanSearch } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { request } from '@/lib/gql';
import { Findings } from './findings';
import { documentText, parseDocument, refusalOf, STARTER_DOCUMENT, stringsOf } from './shapes';

/** How tall the document box is, in lines. */
const DOCUMENT_ROWS = 18;

/** The agent a new revision is for. */
export interface EditedAgent {
  id: string;
  name: string;
  /** The document the editor starts from: the live one, or the newest when none is live. */
  document: unknown;
}

/** What the editor is given. */
export interface AgentEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The agent to save a new revision of, or null to add an agent. */
  agent: EditedAgent | null;
}

/** What a save made. */
interface Saved {
  agentId: string;
  number: number;
  warnings: string[];
}

/**
 * Reads the document typed, for a request: the form's validator has already refused anything else.
 *
 * @param text - The text in the box.
 * @returns The document.
 */
function documentOf(text: string): Record<string, unknown> {
  const parsed = parseDocument(text);
  if ('error' in parsed) {
    throw new Error(parsed.error);
  }
  return parsed.document;
}

/**
 * Says how many warnings a save kept.
 *
 * @param count - How many.
 * @returns "1 warning" or "3 warnings".
 */
function warningCount(count: number): string {
  return count === 1 ? '1 warning' : `${count} warnings`;
}

/**
 * Adds an agent, or saves a new revision of one, from a `cubicecho.agent/1` document typed as JSON.
 * Check asks the server what it thinks without saving; a refused save lists every reason at once.
 */
export function AgentEditorDialog({ open, onOpenChange, agent }: AgentEditorDialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const isNew = agent === null;
  const check = useMutation({
    mutationFn: async (document: Record<string, unknown>) =>
      (await request(CheckAgentDocument, { document, id: agent?.id ?? null })).checkAgent,
    meta: { quiet: true },
  });
  const save = useMutation({
    mutationFn: async ({ document, message }: { document: Record<string, unknown>; message: string | null }) => {
      if (agent === null) {
        const { createAgent } = await request(CreateAgentDocument, { document, message });
        return {
          agentId: createAgent.id,
          number: createAgent.liveRevision?.number ?? 1,
          warnings: stringsOf(createAgent.liveRevision?.warnings),
        } satisfies Saved;
      }
      const { saveAgent } = await request(SaveAgentDocument, { id: agent.id, document, message });
      return { agentId: agent.id, number: saveAgent.number, warnings: stringsOf(saveAgent.warnings) } satisfies Saved;
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      onOpenChange(false);
      if (saved.warnings.length > 0) {
        toast(
          `Saved revision ${saved.number}, and it is live, with ${warningCount(saved.warnings.length)}. They are on the agent's page.`,
          'warning',
        );
      }
      if (isNew) {
        void navigate({ to: '/agents/$agentId', params: { agentId: saved.agentId } });
      }
    },
    // The dialog lists what went wrong, under the document.
    meta: { quiet: true },
  });
  const form = useAppForm({
    defaultValues: { document: documentText(agent?.document ?? STARTER_DOCUMENT), message: '' },
    onSubmit: ({ value }) => {
      const parsed = parseDocument(value.document);
      // The field's validator has already said what is wrong with it.
      if ('error' in parsed) {
        return undefined;
      }
      return save
        .mutateAsync({ document: parsed.document, message: value.message.trim() || null })
        .catch(() => undefined);
    },
  });
  const refusal = save.isError ? refusalOf(save.error) : null;

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isNew ? 'New agent' : `New revision of ${agent.name}`}
      description={
        isNew
          ? "A cubicecho.agent/1 document, as JSON. Its id becomes the agent's name, and its first revision goes live at once."
          : 'Saving makes a new revision and puts it live at once. Every earlier revision stays in the history.'
      }
      size="xl"
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <FormElement onSubmit={() => form.handleSubmit()} className={className}>
            {parts}
          </FormElement>
        </form.AppForm>
      )}
      contentSlot={
        <div className="grid gap-4">
          <TextareaField
            form={form}
            name="document"
            label="Document"
            description={
              isNew
                ? 'Its id is what an app sends as its model to run it.'
                : `Its id stays ${agent.name}: an agent's name never changes.`
            }
            rows={DOCUMENT_ROWS}
            // The field's `className` is its root's, label included, so the box alone is reached past it.
            className="[&_textarea]:font-mono [&_textarea]:text-xs"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            required
            validators={{
              onChange: ({ value }) => {
                const parsed = parseDocument(value);
                return 'error' in parsed ? parsed.error : undefined;
              },
            }}
            // What the server said was about the text before this edit.
            listeners={{
              onChange: () => {
                check.reset();
                save.reset();
              },
            }}
          />
          <InputField
            form={form}
            name="message"
            label="What changed"
            description="Optional. Kept with the revision, in the history."
          />
          {check.data === undefined ? null : <Findings findings={check.data} showClean />}
          {check.isError ? (
            <Alert variant="destructive" title="The check failed" description={check.error.message} />
          ) : null}
          {refusal !== null ? <Findings findings={refusal} /> : null}
          {save.isError && refusal === null ? (
            <Alert variant="destructive" title="It wasn't saved" description={save.error.message} />
          ) : null}
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.Subscribe selector={(state) => state.values.document}>
            {(text) => (
              <Button
                variant="outline"
                iconSlot={<ScanSearch />}
                loading={check.isPending}
                disabled={'error' in parseDocument(text)}
                hint="Asks the router what it makes of the document, without saving it."
                onClick={() => check.mutate(documentOf(text))}
                content="Check"
              />
            )}
          </form.Subscribe>
          <form.SubmitButton
            variant={isNew ? 'info' : 'positive'}
            requireChanges={isNew === false}
            loadingLabel="Saving…"
            content={isNew ? 'Add agent' : 'Save revision'}
          />
        </>
      )}
    />
  );
}
