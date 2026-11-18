import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ServerToolsQuery, TryServerToolDocument } from '@/__generated__/graphql';
import { TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { CopyButton } from '@/components/ui/copy-button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';

/** One tool a server offers. */
export type ServerTool = ServerToolsQuery['serverTools'][number];

/** How many spaces JSON is indented by here. */
const JSON_INDENT = 2;

/**
 * Writes the arguments a tool takes as a JSON object to fill in: each property, empty.
 *
 * @param schema - The tool's input schema.
 * @returns Such as `{ "query": "" }`, or `{}` when the schema names none.
 */
function argumentsTemplate(schema: unknown): string {
  const properties = (schema as { properties?: unknown } | null)?.properties;
  if (typeof properties !== 'object' || properties === null) {
    return '{}';
  }
  const blank = Object.fromEntries(Object.keys(properties).map((name) => [name, '']));
  return JSON.stringify(blank, null, JSON_INDENT);
}

/**
 * Reads the arguments typed as JSON.
 *
 * @param text - The text.
 * @returns What is wrong with it, or undefined for a JSON object.
 */
function argumentsError(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && Array.isArray(value) === false
      ? undefined
      : 'The arguments are one JSON object.';
  } catch {
    return 'That is not JSON.';
  }
}

/** What the try dialog is given. */
export interface TryToolDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  serverName: string;
  tool: ServerTool;
}

/** Calls one of a server's tools with arguments typed as JSON, and shows what it answered. */
export function TryToolDialog({ open, onOpenChange, serverId, serverName, tool }: TryToolDialogProps) {
  const queryClient = useQueryClient();
  const call = useMutation({
    mutationFn: (args: unknown) => request(TryServerToolDocument, { id: serverId, tool: tool.name, arguments: args }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['servers', serverId, 'activity'] }),
    meta: { quiet: true },
  });
  const form = useAppForm({
    defaultValues: { arguments: argumentsTemplate(tool.inputSchema) },
    onSubmit: ({ value }) => call.mutateAsync(JSON.parse(value.arguments)).catch(() => undefined),
  });
  const result = call.data === undefined ? null : JSON.stringify(call.data.tryServerTool, null, JSON_INDENT);
  const schema =
    tool.inputSchema === null || tool.inputSchema === undefined
      ? null
      : JSON.stringify(tool.inputSchema, null, JSON_INDENT);

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`Try ${serverName}__${tool.name}`}
      description={tool.description ?? 'Calls the tool now, on the shared instance. The call shows in its activity.'}
      size="lg"
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
            name="arguments"
            label="Arguments"
            description="One JSON object."
            rows={6}
            validators={{ onChange: ({ value }) => argumentsError(value) }}
          />
          {schema === null ? null : <CodeBlock title="What it takes" language="json" content={schema} maxHeight="sm" />}
          {call.isError ? (
            <Alert variant="destructive" title="The call failed" description={call.error.message} />
          ) : null}
          {result === null ? null : (
            <CodeBlock
              title="What it answered"
              language="json"
              content={result}
              wrap
              maxHeight="md"
              actionSlot={<CopyButton value={result} label="Copy the answer" />}
            />
          )}
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Close" />
          <form.SubmitButton loadingLabel="Calling…" content="Call it" />
        </>
      )}
    />
  );
}
