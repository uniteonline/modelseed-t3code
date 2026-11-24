import {
  ProviderDriverKind,
  type DesktopBackendBootstrap,
  type ProviderInstanceConfigMap,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";

type ModelseedBootstrap = NonNullable<DesktopBackendBootstrap["modelseed"]>;

export function modelseedProviderInstances(account: ModelseedBootstrap): ProviderInstanceConfigMap {
  const apiKey = Redacted.value(account.apiKey);
  return {
    ...(account.codexModels.length > 0
      ? {
          codex: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex · Modelseed",
            config: {
              setupMode: "existing",
              binaryPath: account.codexBinary,
              homePath: account.codexHome,
              customModels: account.codexModels,
            },
            environment: [{ name: "MODELSEED_API_KEY", value: apiKey, sensitive: true }],
          },
        }
      : {}),
    ...(account.claudeModels.length > 0
      ? {
          claudeAgent: {
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Claude Code · Modelseed",
            config: {
              binaryPath: account.claudeBinary,
              homePath: account.claudeHome,
              customModels: account.claudeModels,
            },
            environment: [
              { name: "ANTHROPIC_BASE_URL", value: account.gatewayOrigin, sensitive: false },
              { name: "ANTHROPIC_API_KEY", value: "", sensitive: true },
              { name: "ANTHROPIC_AUTH_TOKEN", value: apiKey, sensitive: true },
              { name: "ANTHROPIC_MODEL_DISCOVERY", value: "1", sensitive: false },
              { name: "ANTHROPIC_CUSTOM_HEADERS", value: "Accept-Language: ru", sensitive: false },
              { name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", value: "1", sensitive: false },
              { name: "CLAUDE_CODE_GIT_BASH_PATH", value: account.gitBash, sensitive: false },
            ],
          },
        }
      : {}),
  };
}

const optionLabels = new Map([
  ["Reasoning effort", "Глубина рассуждений"],
  ["Reasoning", "Рассуждения"],
  ["Effort", "Глубина рассуждений"],
  ["None", "Без рассуждений"],
  ["Minimal", "Минимальная"],
  ["Low", "Низкая"],
  ["Medium", "Средняя"],
  ["High", "Высокая"],
  ["Extra High", "Очень высокая"],
  ["Max", "Максимальная"],
  ["Ultra", "Ультра"],
  ["Service tier", "Приоритет"],
  ["Fast", "Быстрый"],
  ["Fast mode", "Быстрый режим"],
  ["Standard", "Стандартный"],
  ["Default", "По умолчанию"],
  ["Context window", "Размер контекста"],
]);

function localizeOption(option: ProviderOptionDescriptor): ProviderOptionDescriptor {
  const label = optionLabels.get(option.label) ?? option.label;
  if (option.type === "boolean") return { ...option, label };
  return {
    ...option,
    label,
    options: option.options.map((choice) => ({
      ...choice,
      label: optionLabels.get(choice.label) ?? choice.label,
    })),
  };
}

function availableModels(models: ReadonlyArray<ServerProviderModel>, allowed: ReadonlySet<string>) {
  return models
    .filter((model) => allowed.has(model.slug))
    .map((model) => {
      const options = model.capabilities?.optionDescriptors;
      return options === undefined
        ? model
        : {
            ...model,
            capabilities: { ...model.capabilities, optionDescriptors: options.map(localizeOption) },
          };
    });
}

function localizeProvider<T extends ServerProvider>(provider: T, models: ReadonlySet<string>): T {
  return {
    ...provider,
    models: availableModels(provider.models, models),
    ...(provider.message
      ? {
          message:
            provider.status === "error"
              ? "Не удалось подключить агент. Проверьте подключение и перезапустите приложение."
              : "Модели и доступ управляются вашим аккаунтом Modelseed.",
        }
      : {}),
  };
}

export function modelseedProviderDrivers<R>(
  drivers: ReadonlyArray<AnyProviderDriver<R>>,
  account: ModelseedBootstrap,
): ReadonlyArray<AnyProviderDriver<R>> {
  return drivers.flatMap((driver) => {
    const allowed =
      driver.driverKind === "codex"
        ? account.codexModels
        : driver.driverKind === "claudeAgent"
          ? account.claudeModels
          : [];
    if (allowed.length === 0) return [];
    const models = new Set(allowed);
    return [
      {
        ...driver,
        create: (input) =>
          driver.create(input).pipe(
            Effect.map((instance) => {
              const { auth: _auth, ...provider } = instance;
              const { snapshot, snapshotForCwd } = provider;
              return {
                ...provider,
                snapshot: {
                  ...snapshot,
                  getSnapshot: snapshot.getSnapshot.pipe(
                    Effect.map((entry) => localizeProvider(entry, models)),
                  ),
                  refresh: snapshot.refresh.pipe(
                    Effect.map((entry) => localizeProvider(entry, models)),
                  ),
                  streamChanges: snapshot.streamChanges.pipe(
                    Stream.map((entry) => localizeProvider(entry, models)),
                  ),
                },
                ...(snapshotForCwd
                  ? {
                      snapshotForCwd: (cwd: string) =>
                        snapshotForCwd(cwd).pipe(
                          Effect.map((entry) => ({
                            ...localizeProvider(entry, models),
                            ...(entry.workspaceModels
                              ? {
                                  workspaceModels: availableModels(entry.workspaceModels, models),
                                }
                              : {}),
                            ...(entry.optionDescriptors
                              ? {
                                  optionDescriptors: entry.optionDescriptors.map(localizeOption),
                                }
                              : {}),
                          })),
                        ),
                    }
                  : {}),
              };
            }),
          ),
      },
    ];
  });
}
