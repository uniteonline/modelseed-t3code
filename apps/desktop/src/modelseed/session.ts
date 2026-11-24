// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Electron owns the lifetime of the account session and exchange-rate cache.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { app, dialog, safeStorage } from "electron";
import * as Redacted from "effect/Redacted";

import type { DesktopBackendBootstrap, ModelseedBalance } from "@t3tools/contracts";
import {
  createModelseedAccountClient,
  isModelseedAccountError,
  ModelseedAccountError,
  readDeviceAccount,
  type DeviceAccount,
} from "./account.ts";
import { modelseedCatalog } from "./catalog.ts";
import { startModelseedGateway } from "./gateway.ts";
import { prepareModelseedTools } from "./tools.ts";

type Runtime = NonNullable<DesktopBackendBootstrap["modelseed"]>;
const client = createModelseedAccountClient();
let runtime: Runtime | undefined;
let connected: { account: DeviceAccount; path: string } | undefined;
let accountQueue: Promise<unknown> = Promise.resolve();
let signingOut = false;
let closeGateway: (() => void) | undefined;
let fx: { rate: number | null; nextCheck: number } = { rate: null, nextCheck: 0 };

export function currentModelseedRuntime() {
  return runtime;
}

const accountPath = (userDataPath: string) => NodePath.join(userDataPath, "modelseed-account.bin");

async function store(path: string, account: DeviceAccount) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw ModelseedAccountError.new(500, "storage_unavailable");
  }
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const temporary = path + ".tmp";
  try {
    await NodeFSP.writeFile(temporary, safeStorage.encryptString(JSON.stringify(account)));
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function restoreModelseedAccount(userDataPath: string) {
  const path = accountPath(userDataPath);
  const encrypted = await NodeFSP.readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!encrypted) return undefined;
  try {
    return readDeviceAccount(JSON.parse(safeStorage.decryptString(encrypted)));
  } catch {
    throw ModelseedAccountError.new(500, "storage_unavailable");
  }
}

function expired(error: unknown) {
  return isModelseedAccountError(error) && [401, 403, 404, 410].includes(error.status);
}

export function errorText(error: unknown) {
  const code = isModelseedAccountError(error) ? error.code : "";
  if (code === "storage_unavailable") {
    return "Не удалось открыть защищённое хранилище Windows.";
  }
  if (code === "network_unavailable") {
    return "Нет связи с Modelseed. Проверьте подключение к интернету.";
  }
  if (code === "expired_code" || code === "session_expired") {
    return "Срок действия входа истёк. Попробуйте ещё раз.";
  }
  if (code === "access_denied" || code === "user_account_required") {
    return "Не удалось войти в этот аккаунт Modelseed.";
  }
  if (code === "browser_unavailable") {
    return "Не удалось открыть браузер. Попробуйте ещё раз.";
  }
  if (code === "tools_unavailable") {
    return "Не удалось подготовить Codex, Claude Code или Git. Проверьте подключение и повторите попытку.";
  }
  if (isModelseedAccountError(error) && error.status === 429) {
    return "Слишком много запросов. Подождите и повторите попытку.";
  }
  return "Не удалось подключиться к Modelseed. Попробуйте ещё раз.";
}

function returnToLogin() {
  closeGateway?.();
  closeGateway = undefined;
  connected = undefined;
  runtime = undefined;
  app.relaunch();
  app.quit();
}

// Session refresh can rotate credentials. Serialize operations so later requests use the saved bundle.
function withConnected<A>(
  operation: (
    current: NonNullable<typeof connected>,
    persist: (account: DeviceAccount) => Promise<void>,
  ) => Promise<A>,
): Promise<A | null> {
  const result = accountQueue.then(async () => {
    const current = connected;
    if (!current) return null;
    try {
      return await operation(current, async (updated) => {
        await store(current.path, updated);
        current.account = updated;
      });
    } catch (error) {
      if (!expired(error)) throw error;
      await NodeFSP.rm(current.path, { force: true });
      returnToLogin();
      return null;
    }
  });
  accountQueue = result.catch(() => undefined);
  return result;
}

function monitor() {
  const timer = setInterval(() => {
    if (signingOut) return;
    void withConnected(({ account }, persist) => client.verify(account, persist)).catch(
      () => undefined,
    );
  }, 300_000);
  timer.unref();
  app.once("will-quit", () => {
    clearInterval(timer);
    closeGateway?.();
  });
}

export function getModelseedBalance(): Promise<ModelseedBalance | null> {
  if (signingOut) return Promise.resolve(null);
  return withConnected(async ({ account }, persist) => {
    const balance = await client.balance(account, persist);
    if (Date.now() >= fx.nextCheck) {
      fx.nextCheck = Date.now() + 5 * 60_000;
      const rate = await client.rubleRate().catch(() => null);
      if (rate !== null) fx = { rate, nextCheck: Date.now() + 60 * 60_000 };
    }
    return { ...balance, rubPerUSD: fx.rate };
  }).catch(() => null);
}

export async function signOutModelseed() {
  if (!connected || signingOut) return;
  signingOut = true;
  try {
    const choice = await dialog.showMessageBox({
      type: "question",
      title: "Выход из Modelseed",
      message: "Выйти из аккаунта на этом компьютере?",
      detail: "Приложение перезапустится, а задачи в работе остановятся.",
      buttons: ["Отмена", "Выйти"],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice.response !== 1) return;
    await withConnected(async ({ account, path }, persist) => {
      await client.revoke(account, persist);
      await NodeFSP.rm(path, { force: true });
      returnToLogin();
    });
  } catch (error) {
    dialog.showErrorBox("Выход из Modelseed", errorText(error));
  } finally {
    signingOut = false;
  }
}

export async function activateModelseedAccount(
  userDataPath: string,
  account: DeviceAccount,
  signal: AbortSignal,
  onProgress: (message: string) => void,
) {
  const path = accountPath(userDataPath);
  const persist = async (updated: DeviceAccount) => {
    await store(path, updated);
    account = updated;
  };
  onProgress("Проверяем доступ к моделям…");
  let models: string[];
  let pricing: unknown;
  try {
    if (account.pendingAck) {
      await persist(account);
      await persist(await client.acknowledge(account, signal));
    }
    await client.verify(account, persist, signal);
    [models, pricing] = await Promise.all([
      client.models(account.apiKey, signal),
      client.pricing(signal).catch(() => undefined),
    ]);
  } catch (error) {
    if (signal.aborted || !expired(error)) throw error;
    await NodeFSP.rm(path, { force: true });
    return false;
  }

  const catalog = modelseedCatalog(models, pricing);
  onProgress("Готовим Codex и Claude Code. При первом запуске это может занять несколько минут.");
  const gateway = await startModelseedGateway(account.apiKey);
  let tools;
  try {
    let lastProgress = 0;
    tools = await prepareModelseedTools(userDataPath, gateway.origin, signal, (percent) => {
      if (percent < 100 && percent - lastProgress < 5) return;
      lastProgress = percent;
      onProgress(
        percent >= 100
          ? "Проверяем и устанавливаем инструменты…"
          : `Готовим Codex и Claude Code. Загрузка ${percent} %.`,
      );
    });
    signal.throwIfAborted();
  } catch (error) {
    gateway.close();
    if (signal.aborted) throw error;
    throw ModelseedAccountError.new(503, "tools_unavailable");
  }
  closeGateway = gateway.close;
  connected = { account, path };
  runtime = {
    ...catalog,
    ...tools,
    gatewayOrigin: gateway.origin,
    apiKey: Redacted.make(gateway.token),
  };
  monitor();
  return true;
}
