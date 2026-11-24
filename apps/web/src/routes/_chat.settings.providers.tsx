import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { useEnvironmentProviders } from "../state/environments";

/* oxlint-disable t3code/no-untranslated-copy -- The Modelseed provider view only renders in the Russian edition. */
const modelseedProviderCopy = {
  description:
    "Codex и Claude Code используют ваш аккаунт Modelseed. Модели появляются в списке автоматически в зависимости от доступа аккаунта.",
  empty: "Нет доступных моделей.",
  loading: "Проверяем доступные модели…",
};

function ModelseedProviders({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  return (
    <SettingsPageContainer>
      <SettingsSection id="modelseed" title="Modelseed">
        <p className="text-sm text-muted-foreground">{modelseedProviderCopy.description}</p>
        {providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{modelseedProviderCopy.empty}</p>
        ) : (
          <ul className="space-y-3">
            {providers.map((provider) => (
              <li key={provider.instanceId}>
                <p className="text-sm font-medium">{provider.displayName}</p>
                <p className="text-sm text-muted-foreground">
                  {provider.models.map((model) => model.name).join(", ") ||
                    provider.message ||
                    modelseedProviderCopy.loading}
                </p>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
/* oxlint-enable t3code/no-untranslated-copy */

function SettingsProvidersRoute() {
  const target = Route.useSearch();
  const { environment, scope } = useSettingsScope();
  const gt = useGT();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? gt("Reconnect {label} to set up its providers.", { label: scope.label })
          : gt("Connect an environment to set up its providers.")}
      </p>
    );
  }
  if (window.desktopBridge?.signOutModelseed) {
    return <ModelseedProviders environmentId={environment.environmentId} />;
  }
  return (
    <ProviderSettingsPanel
      environmentId={environment.environmentId}
      {...(target.instanceId ? { instanceId: target.instanceId } : {})}
      projectIds={
        scope.kind === "project" || scope.kind === "checkout"
          ? scope.members
              .filter((member) => member.environmentId === environment.environmentId)
              .map((member) => member.id)
          : []
      }
      scoped
    />
  );
}

export const Route = createFileRoute("/_chat/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: SettingsProvidersRoute,
});
