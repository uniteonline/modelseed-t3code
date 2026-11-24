// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Electron window events own the lifetime of the device session.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { app, clipboard, dialog, safeStorage, shell } from "electron";
import * as Redacted from "effect/Redacted";

import type { DesktopBackendBootstrap } from "@t3tools/contracts";
import {
  createModelseedAccountClient,
  isModelseedAccountError,
  MODELSEED_DEVICES,
  ModelseedAccountError,
  readDeviceAccount,
  type DeviceAccount,
  type DeviceAuthorization,
} from "./account.ts";
import { modelseedCatalog } from "./catalog.ts";
import { startModelseedGateway } from "./gateway.ts";
import { modelseedLoginWindow } from "./loginWindow.ts";
import { prepareModelseedTools } from "./tools.ts";

type Runtime = NonNullable<DesktopBackendBootstrap["modelseed"]>;
const client = createModelseedAccountClient();
let runtime: Runtime | undefined;
let connected: { account: DeviceAccount; path: string } | undefined;
let verification: Promise<void> = Promise.resolve();
let busySigningOut = false;
let closeGateway: (() => void) | undefined;

export function currentModelseedRuntime() {
  return runtime;
}

async function store(path: string, account: DeviceAccount) {
  if (!safeStorage.isEncryptionAvailable())
    throw ModelseedAccountError.new(500, "storage_unavailable");
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const temporary = path + ".tmp";
  try {
    await NodeFSP.writeFile(temporary, safeStorage.encryptString(JSON.stringify(account)));
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function restore(path: string): Promise<DeviceAccount | undefined> {
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

function errorText(error: unknown) {
  const code = isModelseedAccountError(error) ? error.code : "";
  if (code === "storage_unavailable") return "Не удалось открыть защищённое хранилище Windows.";
  if (code === "network_unavailable")
    return "Нет связи с Modelseed. Проверьте подключение к интернету.";
  if (code === "expired_code" || code === "session_expired") return "Срок действия входа истёк.";
  if (code === "access_denied") return "Подключение устройства отклонено или отозвано.";
  if (isModelseedAccountError(error) && error.status === 429)
    return "Слишком много запросов. Подождите и повторите попытку.";
  return "Не удалось подключиться. Повторите попытку.";
}

function returnToLogin() {
  closeGateway?.();
  connected = undefined;
  runtime = undefined;
  app.relaunch();
  app.quit();
}

function monitor() {
  const timer = setInterval(() => {
    if (busySigningOut || !connected) return;
    busySigningOut = true;
    const current = connected;
    verification = client
      .verify(current.account, async (updated) => {
        await store(current.path, updated);
        current.account = updated;
      })
      .catch(async (error: unknown) => {
        if (!expired(error)) return;
        await NodeFSP.rm(current.path, { force: true });
        returnToLogin();
      })
      .catch(() => undefined)
      .finally(() => {
        busySigningOut = false;
      });
  }, 300_000);
  timer.unref();
  app.once("will-quit", () => {
    clearInterval(timer);
    closeGateway?.();
  });
}

export async function signOutModelseed() {
  await verification;
  const current = connected;
  if (!current || busySigningOut) return;
  busySigningOut = true;
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
    try {
      await client.revoke(current.account, async (update) => {
        await store(current.path, update);
        current.account = update;
      });
    } catch (error) {
      if (!expired(error)) throw error;
    }
    await NodeFSP.rm(current.path, { force: true });
    returnToLogin();
  } catch (error) {
    dialog.showErrorBox("Выход из Modelseed", errorText(error));
  } finally {
    busySigningOut = false;
  }
}

export async function requireModelseedLogin(userDataPath: string) {
  const path = NodePath.join(userDataPath, "modelseed-account.bin");
  const cancel = new AbortController();
  let authorization: DeviceAuthorization | undefined;
  let pending: DeviceAccount | undefined;
  let busy = false;
  let ready = false;
  const login = modelseedLoginWindow((action) => {
    if (action === "copy") {
      if (authorization) clipboard.writeText(authorization.userCode);
      return;
    }
    if (action === "browser") {
      void shell
        .openExternal(MODELSEED_DEVICES)
        .catch(() =>
          login.show({
            status: "Откройте console.modelseed.dev/devices в браузере и введите код.",
            ...(authorization ? { code: authorization.userCode } : {}),
            actions: [{ action: "copy", label: "Копировать код" }],
          }),
        )
        .catch(() => undefined);
      return;
    }
    if (!busy) void attempt(action === "start");
  });

  let resolveLogin: (close: (() => void) | null) => void;
  const finished = new Promise<(() => void) | null>((resolve) => {
    resolveLogin = resolve;
  });
  login.window.once("closed", () => {
    cancel.abort();
    if (!ready) {
      resolveLogin(null);
      app.quit();
    }
  });

  async function accept(account: DeviceAccount) {
    await login.show({ status: "Проверяем доступ к моделям…" });
    const persist = async (updated: DeviceAccount) => {
      await store(path, updated);
      pending = updated;
    };
    if (account.pendingAck) {
      await persist(account);
      account = await client.acknowledge(account, cancel.signal);
      await persist(account);
    }
    await client.verify(account, persist, cancel.signal);
    const [models, pricing] = await Promise.all([
      client.models(account.apiKey, cancel.signal),
      client.pricing(cancel.signal).catch(() => undefined),
    ]);
    const catalog = modelseedCatalog(models, pricing);
    await login.show({
      status: "Готовим Codex и Claude Code. При первом запуске это может занять несколько минут.",
    });
    const gateway = await startModelseedGateway(account.apiKey);
    let tools;
    try {
      let lastProgress = 0;
      tools = await prepareModelseedTools(
        userDataPath,
        gateway.origin,
        cancel.signal,
        (percent) => {
          if (percent < 100 && percent - lastProgress < 5) return;
          lastProgress = percent;
          const status =
            percent >= 100
              ? "Проверяем и устанавливаем инструменты…"
              : "Готовим Codex и Claude Code. Загрузка " + percent + " %.";
          void login.show({ status }).catch(() => undefined);
        },
      );
      cancel.signal.throwIfAborted();
    } catch (error) {
      gateway.close();
      if (cancel.signal.aborted) throw error;
      throw ModelseedAccountError.new(503, "tools_unavailable");
    }
    closeGateway = gateway.close;
    connected = { account: pending ?? account, path };
    runtime = {
      ...catalog,
      ...tools,
      gatewayOrigin: gateway.origin,
      apiKey: Redacted.make(gateway.token),
    };
    ready = true;
    monitor();
    await login.show({ status: "Открываем рабочее пространство…" });
    resolveLogin(() => {
      if (!login.window.isDestroyed()) login.window.close();
    });
  }

  async function attempt(start: boolean) {
    busy = true;
    authorization = undefined;
    const signal = cancel.signal;
    try {
      if (!start) {
        await login.show({ status: "Подключаемся к Modelseed…" });
        pending ??= await restore(path);
        if (pending) {
          await accept(pending);
          return;
        }
        await login.show({
          status: "Войдите через браузер, чтобы открыть свои модели в Codex и Claude Code.",
          actions: [{ action: "start", label: "Войти в Modelseed" }],
        });
        return;
      }
      await login.show({ status: "Получаем код подключения…" });
      const name = NodeOS.hostname()
        .replace(/[\x00-\x1f\x7f]/g, "")
        .trim();
      authorization = await client.start(("T3 Code · " + name).slice(0, 60), signal);
      const challenge = authorization;
      const showCode = (status: string) =>
        login.show({
          status,
          code: challenge.userCode,
          actions: [
            { action: "browser", label: "Открыть браузер" },
            { action: "copy", label: "Копировать код" },
          ],
        });
      await showCode(
        "Введите этот код на странице Modelseed и подтвердите подключение устройства.",
      );
      await shell.openExternal(MODELSEED_DEVICES).catch(() => undefined);
      while (Date.now() < challenge.expiresAt) {
        await NodeTimersPromises.setTimeout(challenge.interval, undefined, { signal });
        try {
          const account = await client.poll(challenge, signal);
          if (!account) continue;
          authorization = undefined;
          await accept(account);
          return;
        } catch (error) {
          if (
            authorization &&
            isModelseedAccountError(error) &&
            [0, 429, 502, 503].includes(error.status)
          ) {
            if (error.status === 0)
              await showCode("Ждём подтверждения. Проверяем связь с Modelseed…");
            continue;
          }
          throw error;
        }
      }
      throw ModelseedAccountError.new(410, "expired_code");
    } catch (error) {
      if (signal.aborted) return;
      if (expired(error) && pending) {
        await NodeFSP.rm(path, { force: true }).catch(() => undefined);
        pending = undefined;
      }
      authorization = undefined;
      const status =
        isModelseedAccountError(error) && error.code === "tools_unavailable"
          ? "Не удалось подготовить Codex, Claude Code или Git. Проверьте подключение и повторите попытку."
          : errorText(error);
      await login
        .show({
          status,
          actions: [{ action: pending || !start ? "retry" : "start", label: "Повторить" }],
        })
        .catch(() => undefined);
    } finally {
      busy = false;
    }
  }

  void attempt(false);
  return finished;
}
