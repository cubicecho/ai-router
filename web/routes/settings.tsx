import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MeDocument,
  RouterSettingsDocument,
  type RouterSettingsQuery,
  UpdateRouterSettingsDocument,
} from '@/__generated__/graphql';
import { NumberField, useAppForm } from '@/components/app-form';
import { CardLayout } from '@/components/card-layout';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';
import { Role } from '@/lib/roles';

/** The router's settings, as the page reads them. */
type RouterSettings = RouterSettingsQuery['routerSettings'];

/** What the app-tool cap is called on the page. */
const MAX_APP_TOOLS_LABEL = 'Most tools per request';

/**
 * Says what the app-tool cap does.
 *
 * @param setting - The cap, with its default and range.
 * @returns One line for under the field or the value.
 */
function maxAppToolsDescription(setting: RouterSettings['maxAppTools']): string {
  const source = setting.saved === null ? 'the default' : `set by an admin; the default is ${setting.default}`;
  return `The most tools an app may send with one request. OpenAI's own limit is 128. From ${setting.min} to ${setting.max}, now ${source}.`;
}

/** What the settings form is given. */
interface SettingsFormProps {
  settings: RouterSettings;
}

/**
 * The admin's form: each setting as a field, saved together, and a way back to the defaults.
 *
 * @param props - The settings as they are now.
 * @returns The card with the form.
 */
function SettingsForm({ settings }: SettingsFormProps) {
  const queryClient = useQueryClient();
  const { maxAppTools } = settings;
  // null returns a setting to its default, so it follows the default if that changes.
  const save = useMutation({
    mutationFn: (input: { maxAppTools: number | null }) => request(UpdateRouterSettingsDocument, { input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['routerSettings'] }),
  });
  // null while the box is empty or holds a fraction, for the validator to report.
  const values: { maxAppTools: number | null } = { maxAppTools: maxAppTools.value };
  const form = useAppForm({
    defaultValues: values,
    onSubmit: ({ value }) => save.mutateAsync(value),
  });
  const isDefault = maxAppTools.saved === null;

  return (
    <CardLayout
      title="Apps"
      level={2}
      description="What an app may send to the agents endpoint, /v1."
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <FormElement onSubmit={() => form.handleSubmit()} className={className}>
            {parts}
          </FormElement>
        </form.AppForm>
      )}
      contentSlot={
        <NumberField
          form={form}
          name="maxAppTools"
          label={MAX_APP_TOOLS_LABEL}
          description={maxAppToolsDescription(maxAppTools)}
          required
          integer
          min={maxAppTools.min}
          max={maxAppTools.max}
          validators={{
            onChange: ({ value }) => {
              const isOutOfRange = value === null || value < maxAppTools.min || value > maxAppTools.max;
              return isOutOfRange ? `Enter a whole number from ${maxAppTools.min} to ${maxAppTools.max}.` : undefined;
            },
          }}
        />
      }
      footerActionsSlot={
        <>
          {isDefault ? null : (
            <Button
              variant="outline"
              loading={save.isPending && save.variables?.maxAppTools === null}
              onClick={() => save.mutate({ maxAppTools: null })}
              content="Use the default"
            />
          )}
          <form.SubmitButton requireChanges content="Save" />
        </>
      }
    />
  );
}

/**
 * The settings as a user who is not an admin sees them: read only.
 *
 * @param props - The settings as they are now.
 * @returns The card with each setting's value.
 */
function SettingsValues({ settings }: SettingsFormProps) {
  const { maxAppTools } = settings;
  return (
    <CardLayout
      title="Apps"
      level={2}
      description="What an app may send to the agents endpoint, /v1. Only an admin can change these."
      contentSlot={
        <PropertyList
          contentSlot={
            <PropertyRow
              label={MAX_APP_TOOLS_LABEL}
              value={String(maxAppTools.value)}
              hint={maxAppToolsDescription(maxAppTools)}
            />
          }
        />
      }
    />
  );
}

/**
 * Picks what the page shows once both answers are in.
 *
 * @param settings - The router's settings.
 * @param isAdmin - Whether the person reading is an admin.
 * @returns The form for an admin, the values for anyone else.
 */
function settingsBody(settings: RouterSettings, isAdmin: boolean) {
  if (isAdmin) {
    // Keyed by what is saved, so the form starts again from the saved values after each save.
    return <SettingsForm key={JSON.stringify(settings)} settings={settings} />;
  }
  return <SettingsValues settings={settings} />;
}

/** The router's settings. An admin changes them here; anyone else who opens the page reads them. */
export function SettingsRoute() {
  const settings = useQuery({ queryKey: ['routerSettings'], queryFn: () => request(RouterSettingsDocument) });
  const me = useQuery({ queryKey: ['me'], queryFn: () => request(MeDocument) });
  const record = settings.data?.routerSettings;
  const role = me.data?.me.role;

  return (
    <PageLayout
      width="page"
      title="Settings"
      description="How the router treats every app. A change applies from each app's next request."
      contentSlot={
        record === undefined || role === undefined ? (
          <LoadState query={settings} what="the settings" record={record} notFoundLabel="No settings" level={2} />
        ) : (
          settingsBody(record, role === Role.Admin)
        )
      }
    />
  );
}
