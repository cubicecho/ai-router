import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { CheckAgentDocument, CreateAgentDocument, SaveAgentDocument } from '@/__generated__/graphql';
import { CheckboxField, InputField, NumberField, SelectField, TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { EmptyState } from '@/components/empty-state';
import { FieldRow } from '@/components/field-row';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { FilePen, Plus, ScanSearch, Trash2 } from '@/components/ui/icons';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import { useToast } from '@/components/ui/toast';
import { request } from '@/lib/gql';
import { NAME_HINT, NAME_PATTERN } from '@/models/names';
import {
  type AgentFormValues,
  documentFrom,
  formValuesOf,
  isPromptEditable,
  NEW_PART,
  PromptLayout,
  type PromptPartValues,
} from './agent-form';
import { Findings } from './findings';
import { documentText, parseDocument, refusalOf, STARTER_DOCUMENT, stringsOf } from './shapes';

/** How tall the JSON box is, in lines. */
const DOCUMENT_ROWS = 18;
/** How tall a prompt part's box is, in lines. */
const PART_ROWS = 4;

/** The editor's two views of one document. */
const EditorView = { Form: 'form', Json: 'json' } as const;
type EditorView = (typeof EditorView)[keyof typeof EditorView];

/** The layouts, as people read them. */
const LAYOUT_OPTIONS = [
  { value: PromptLayout.Plain, label: 'Plain: the parts one after another' },
  { value: PromptLayout.Markdown, label: 'Markdown: each part under a heading' },
  { value: PromptLayout.Xml, label: 'XML: each part in its own tag' },
];

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

/** What the form holds: the document's fields, the JSON view's text, and the revision's message. */
interface EditorValues extends AgentFormValues {
  json: string;
  message: string;
}

/**
 * Reads the document the editor starts from.
 *
 * @param agent - The agent, or null for a new one.
 * @returns Its document, or the starter.
 */
function startingDocument(agent: EditedAgent | null): Record<string, unknown> {
  const parsed = parseDocument(documentText(agent?.document ?? STARTER_DOCUMENT));
  return 'error' in parsed ? { ...STARTER_DOCUMENT } : parsed.document;
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
 * Finds what is wrong with the prompt's part names.
 *
 * @param parts - The parts.
 * @returns The first problem, or undefined.
 */
function partNameError(parts: readonly PromptPartValues[]): string | undefined {
  const names = parts.map((part) => part.name.trim());
  if (names.some((name) => name === '')) {
    return 'Every part needs a name.';
  }
  return new Set(names).size === names.length ? undefined : 'Two parts have the same name.';
}

/**
 * Adds an agent, or saves a new revision of one. The form sets what agents usually need; the JSON view holds the
 * whole document, and a document pasted there fills the form. Check asks the server what it thinks without saving.
 */
export function AgentEditorDialog({ open, onOpenChange, agent }: AgentEditorDialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const isNew = agent === null;
  const [view, setView] = useState<EditorView>(EditorView.Form);
  const [initial] = useState(() => startingDocument(agent));
  // What the form doesn't show is kept from here: the document it was last filled from.
  const [base, setBase] = useState<Record<string, unknown>>(initial);
  const [jsonError, setJsonError] = useState<string | null>(null);

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
    // The dialog lists what went wrong, under the form.
    meta: { quiet: true },
  });

  const form = useAppForm({
    defaultValues: { ...formValuesOf(initial), json: documentText(initial), message: '' } satisfies EditorValues,
    onSubmit: ({ value }) => {
      const document = currentDocument(value);
      if (document === null) {
        return undefined;
      }
      return save.mutateAsync({ document, message: value.message.trim() || null }).catch(() => undefined);
    },
    listeners: {
      // What the server said was about the document before this edit.
      onChange: () => {
        check.reset();
        save.reset();
      },
    },
  });

  /**
   * Reads the document the dialog would save now: the JSON view's text there, the form over its base here.
   *
   * @param values - The form's values.
   * @returns The document, or null when the JSON isn't one (and says so).
   */
  function currentDocument(values: EditorValues): Record<string, unknown> | null {
    if (view === EditorView.Form) {
      return documentFrom(base, values);
    }
    const parsed = parseDocument(values.json);
    if ('error' in parsed) {
      setJsonError(parsed.error);
      return null;
    }
    return parsed.document;
  }

  /**
   * Fills the form from a document, which becomes what the form keeps everything else from.
   *
   * @param document - The document.
   */
  function fillForm(document: Record<string, unknown>): void {
    setBase(document);
    const { json, message } = form.state.values;
    // The defaults stay the agent's own document, so a save still knows whether anything changed.
    form.reset({ ...formValuesOf(document), json, message }, { keepDefaultValues: true });
  }

  /**
   * Switches between the form and the JSON. Leaving the JSON fills the form from it, so a pasted document lands in
   * the fields; JSON that isn't a document keeps the JSON view open, saying why.
   *
   * @param next - The view to show.
   */
  function switchView(next: EditorView): void {
    if (next === view) {
      return;
    }
    if (next === EditorView.Json) {
      form.setFieldValue('json', documentText(documentFrom(base, form.state.values)));
      setJsonError(null);
      setView(next);
      return;
    }
    const parsed = parseDocument(form.state.values.json);
    if ('error' in parsed) {
      setJsonError(parsed.error);
      return;
    }
    fillForm(parsed.document);
    setJsonError(null);
    setView(next);
  }

  const refusal = save.isError ? refusalOf(save.error) : null;
  const promptEditable = isPromptEditable(base);

  const formView = (
    <div className="grid gap-6">
      <Section
        title="About it"
        contentSlot={
          <div className="grid gap-4">
            <FieldRow
              contentSlot={
                <>
                  <InputField
                    form={form}
                    name="id"
                    label="Id"
                    description={
                      isNew
                        ? `What an app sends as its model to run it. ${NAME_HINT}`
                        : `An agent's id never changes: it stays ${agent.name}.`
                    }
                    disabled={isNew === false}
                    required
                    validators={{
                      onChange: ({ value }) => (NAME_PATTERN.test(value.trim()) ? undefined : NAME_HINT),
                    }}
                  />
                  <InputField form={form} name="name" label="Name" description="Left blank, the id is its name." />
                </>
              }
            />
            <InputField
              form={form}
              name="description"
              label="Description"
              description="One line for whoever picks between agents. The model never sees it."
            />
          </div>
        }
      />
      <Section
        title="Model"
        contentSlot={
          <div className="grid gap-4">
            <InputField
              form={form}
              name="model"
              label="Model"
              placeholder="ollama/qwen3:32b"
              description="A provider's model as <provider>/<model>, or a pool's name."
              required
              validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Name a model.' : undefined) }}
            />
            <FieldRow
              perRow={3}
              contentSlot={
                <>
                  <NumberField
                    form={form}
                    name="temperature"
                    label="Temperature"
                    description="0 to 2. Blank leaves it to the model."
                    min={0}
                    max={2}
                    step={0.1}
                  />
                  <NumberField
                    form={form}
                    name="maxTokens"
                    label="Max tokens"
                    description="The reply's ceiling. Blank leaves it to the model."
                    integer
                    min={0}
                  />
                  <InputField
                    form={form}
                    name="reasoningEffort"
                    label="Reasoning effort"
                    placeholder="low, medium, high"
                    description="Blank sends none."
                  />
                </>
              }
            />
          </div>
        }
      />
      <Section
        title="Prompt"
        description="Its parts, in order. An app's own parts and system messages come after them, and can't change them but as each part allows."
        actionSlot={
          promptEditable ? (
            <Button
              variant="positive"
              size="sm"
              iconSlot={<Plus />}
              onClick={() => form.pushFieldValue('prompt', { ...NEW_PART })}
              content="Add part"
            />
          ) : undefined
        }
        contentSlot={
          <div className="grid gap-4">
            <SelectField
              form={form}
              name="promptLayout"
              label="Layout"
              description="How the parts are written for the model. Which reads best depends on the model."
              options={LAYOUT_OPTIONS}
            />
            {promptEditable ? (
              <form.Subscribe selector={(state) => state.values.prompt}>
                {(parts) => (
                  <div className="grid gap-4">
                    {parts.map((_part, index) => (
                      // A part has no key of its own until its name is typed, and its place is what the fields bind to.
                      // biome-ignore lint/suspicious/noArrayIndexKey: the fields are bound by index.
                      <div key={index} className="grid gap-2">
                        <div className="flex items-end gap-2">
                          <InputField
                            form={form}
                            name={`prompt[${index}].name`}
                            label="Part name"
                            placeholder="identity"
                            description="What it is for: identity, rules, format. It can't start with the word app."
                            className="flex-1"
                            required
                          />
                          <Button
                            variant="destructive-outline"
                            size="icon"
                            aria-label={`Remove part ${index + 1}`}
                            iconSlot={<Trash2 />}
                            onClick={() => form.removeFieldValue('prompt', index)}
                          />
                        </div>
                        <TextareaField form={form} name={`prompt[${index}].content`} label="Text" rows={PART_ROWS} />
                        <FieldRow
                          contentSlot={
                            <>
                              <CheckboxField
                                form={form}
                                name={`prompt[${index}].appsExtend`}
                                label="Apps may extend it"
                                description="An app's part adds to it. The model is told this part wins where they conflict."
                              />
                              <CheckboxField
                                form={form}
                                name={`prompt[${index}].appsReplace`}
                                label="Apps may replace it"
                                description="An app's part takes its place, and the model follows the app's."
                              />
                            </>
                          }
                        />
                      </div>
                    ))}
                    {parts.length === 0 ? <EmptyState compact title="No prompt yet." /> : null}
                    {partNameError(parts) === undefined || parts.length === 0 ? null : (
                      <Alert variant="warning" title="Check the part names" description={partNameError(parts)} />
                    )}
                  </div>
                )}
              </form.Subscribe>
            ) : (
              <Alert
                variant="info"
                title="Its prompt is edited in the JSON"
                description="A part has a mode or a key the form can't show. The form keeps the prompt as it is."
              />
            )}
          </div>
        }
      />
      <Section
        title="Tools"
        description="Its MCP servers are chosen on each workspace that runs it, on the workspace's Agents tab."
        contentSlot={
          <NumberField
            form={form}
            name="maxIterations"
            label="Most tool rounds"
            description="Where a tool loop stops. Blank leaves it to the router's default."
            integer
            min={1}
          />
        }
      />
      <InputField
        form={form}
        name="message"
        label="What changed"
        description="Optional. Kept with the revision, in the history."
      />
      <p className="text-foreground/60 text-sm">
        Anything else in the document, such as its endpoint, side tasks or hooks, is kept as it is. Edit it in the JSON.
      </p>
    </div>
  );

  const jsonView = (
    <div className="grid gap-4">
      <TextareaField
        form={form}
        name="json"
        label="Document"
        description="The whole cubicecho.agent/2 document. Paste one here, then fill the form from it."
        rows={DOCUMENT_ROWS}
        // The field's `className` is its root's, label included, so the box alone is reached past it.
        className="[&_textarea]:font-mono [&_textarea]:text-xs"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        listeners={{ onChange: () => setJsonError(null) }}
      />
      {jsonError === null ? null : (
        <Alert variant="destructive" title="That isn't a document" description={jsonError} />
      )}
      <div>
        <Button
          variant="positive-outline"
          iconSlot={<FilePen />}
          onClick={() => switchView(EditorView.Form)}
          content="Fill the form from this"
        />
      </div>
      <InputField
        form={form}
        name="message"
        label="What changed"
        description="Optional. Kept with the revision, in the history."
      />
    </div>
  );

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isNew ? 'New agent' : `New revision of ${agent.name}`}
      description={
        isNew
          ? 'Its first revision goes live at once. Fill in the form, or paste a cubicecho.agent/2 document as JSON.'
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
        <>
          <SegmentedGroup aria-label="How to edit it" value={view} onValueChange={switchView}>
            <SegmentedButton value={EditorView.Form}>Form</SegmentedButton>
            <SegmentedButton value={EditorView.Json}>JSON</SegmentedButton>
          </SegmentedGroup>
          {view === EditorView.Form ? formView : jsonView}
          {check.data === undefined ? null : <Findings findings={check.data} showClean />}
          {check.isError ? (
            <Alert variant="destructive" title="The check failed" description={check.error.message} />
          ) : null}
          {refusal !== null ? <Findings findings={refusal} /> : null}
          {save.isError && refusal === null ? (
            <Alert variant="destructive" title="It wasn't saved" description={save.error.message} />
          ) : null}
        </>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <Button
            variant="outline"
            iconSlot={<ScanSearch />}
            loading={check.isPending}
            hint="Asks the router what it makes of the document, without saving it."
            onClick={() => {
              const document = currentDocument(form.state.values);
              if (document !== null) {
                check.mutate(document);
              }
            }}
            content="Check"
          />
          <form.SubmitButton
            requireChanges={isNew === false}
            loadingLabel="Saving…"
            content={isNew ? 'Add agent' : 'Save revision'}
          />
        </>
      )}
    />
  );
}
