import type { KeyValueRow } from "@/lib/key-value";
/**
 * A `KeyValueEditor`, bound to a form field holding a list of `{ key, value }` rows.
 *
 * The field is `asGroup`: the rows are a `group`, which a `<label>` cannot name, so it points back
 * at the label by `aria-labelledby`, as `SegmentedField` does. The field's error is the list's —
 * a name used twice, a row with no name — and a validator over the whole list says it:
 *
 * ```tsx
 * <form.AppField
 *   name="headers"
 *   validators={{
 *     onChange: ({ value }) =>
 *       duplicateKeys(value).length > 0 ? "Each header may be sent once." : undefined,
 *   }}
 * >
 *   {() => <KeyValueField label="Headers" keyLabel="Name" valueLabel="Value" addLabel="Add header" masked />}
 * </form.AppField>
 * ```
 *
 * Or on `field.*`, with `createAppForm({ KeyValueField })`, or as one line with `bindToForm`.
 * `recordToRows` fills `defaultValues` from a record, and `rowsToRecord` turns the rows back on
 * submit.
 */
import { type FieldProps, FieldWrapper, splitProps, useFieldContext } from "@/components/ui/form";
import { KeyValueEditor, type KeyValueEditorProps } from "@/components/ui/key-value-editor";

type KeyValueFieldProps = FieldProps &
  Omit<
    KeyValueEditorProps,
    | "value"
    | "onValueChange"
    | "onBlur"
    | "id"
    | "aria-label"
    | "aria-labelledby"
    | "aria-describedby"
    | "aria-invalid"
    | "className"
    | "disabled"
  >;

/**
 * The editor, as one element for `FieldControl` to hand the `id`, the `aria-*` props and the
 * field's `disabled` to.
 */
function KeyValueFieldControl(
  props: Omit<KeyValueEditorProps, "value" | "onValueChange" | "onBlur">,
) {
  const field = useFieldContext<KeyValueRow[] | null>();
  return (
    <KeyValueEditor
      {...props}
      value={field.state.value ?? []}
      onValueChange={(rows) => field.handleChange(rows)}
      onBlur={field.handleBlur}
    />
  );
}

/** A `KeyValueEditor` bound to a form field holding a list of `{ key, value }` rows. */
export function KeyValueField(props: KeyValueFieldProps) {
  const [fieldProps, control] = splitProps(props);
  return (
    <FieldWrapper asGroup {...fieldProps} controlSlot={<KeyValueFieldControl {...control} />} />
  );
}

export type { KeyValueFieldProps };
