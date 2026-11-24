// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- This is the desktop login and browser callback lifecycle.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import { app, shell } from "electron";
import type { ModelseedLoginAction, ModelseedLoginStatus } from "@t3tools/contracts";
import {
  createModelseedAccountClient,
  MODELSEED_CONSOLE,
  ModelseedAccountError,
  isModelseedAccountError,
} from "./account.ts";
import { activateModelseedAccount, errorText, restoreModelseedAccount } from "./session.ts";

const client = createModelseedAccountClient();
const secret = () => NodeCrypto.randomBytes(32).toString("base64url");
const challengeFor = (verifier: string) =>
  NodeCrypto.createHash("sha256").update(verifier).digest("hex");
type OAuthProvider = Extract<ModelseedLoginAction, { kind: "oauth" }>["provider"];
let status: ModelseedLoginStatus = { screen: "working", message: "Проверяем вход…" };
let accept: ((action: ModelseedLoginAction) => void) | undefined;

export function dispatchModelseedLogin(action: ModelseedLoginAction) {
  if (action.kind !== "status") accept?.(action);
  return status;
}

export function modelseedWorkspaceReady() {
  status = { screen: "ready", message: "" };
}

async function browserLogin(provider: OAuthProvider, signal: AbortSignal) {
  const verifier = secret();
  const state = secret();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
  let port = 0;
  let resolveCode: (code: string) => void;
  const codePromise = new Promise<string>((resolve) => {
    resolveCode = resolve;
  });
  const server = NodeHttp.createServer(
    { requestTimeout: 6000, headersTimeout: 4000 },
    (req, res) => {
      const destination = URL.parse(req.url ?? "/", "http://127.0.0.1");
      const code = destination?.searchParams.get("code");
      if (
        req.method !== "GET" ||
        req.headers.host !== `127.0.0.1:${port}` ||
        destination?.pathname !== "/modelseed/callback" ||
        destination.searchParams.get("state") !== state ||
        !code ||
        !/^[A-Za-z0-9_-]{43}$/.test(code)
      ) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      });
      res.end(
        '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Modelseed</title><h1>Возвращайтесь в Modelseed T3 Code</h1><p>Эту вкладку можно закрыть.</p></html>',
      );
      resolveCode(code);
    },
  );
  try {
    await new Promise<void>((resolve, reject) =>
      server.once("error", reject).listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw ModelseedAccountError.new(500, "browser_unavailable");
    port = address.port;
    const url = new URL("/api/installer/desktop/login", MODELSEED_CONSOLE);
    url.search = new URLSearchParams({
      provider,
      challenge: challengeFor(verifier),
      state,
      port: String(port),
    }).toString();
    await shell.openExternal(url.href).catch(() => {
      throw ModelseedAccountError.new(500, "browser_unavailable");
    });
    const code = await new Promise<string>((resolve, reject) => {
      const cancel = () => reject(ModelseedAccountError.new(410, "expired_code"));
      if (deadline.aborted) {
        cancel();
        return;
      }
      deadline.addEventListener("abort", cancel, { once: true });
      void codePromise.then((value) => {
        deadline.removeEventListener("abort", cancel);
        resolve(value);
      });
    });
    return client.exchange(code, verifier, signal);
  } finally {
    server.close();
    server.closeIdleConnections();
  }
}

export function requireModelseedLogin(userDataPath: string): Promise<boolean> {
  const stop = new AbortController();
  let browser: AbortController | undefined;
  let flow: string | undefined;
  let busy = false;

  function show(screen: ModelseedLoginStatus["screen"], message = "", allowBrowser = false) {
    status = { screen, message, ...(allowBrowser ? { allowBrowser } : {}) };
  }

  return new Promise<boolean>((resolve) => {
    const detach = () => {
      accept = undefined;
      app.removeListener("before-quit", cancel);
    };
    const cancel = () => {
      stop.abort();
      browser?.abort();
      detach();
      resolve(false);
    };
    app.once("before-quit", cancel);

    async function attempt(action: ModelseedLoginAction) {
      if (action.kind === "status") return;
      if (action.kind === "cancel") {
        if (browser) {
          browser.abort();
          return;
        }
        if (busy) return;
        flow = undefined;
        show("login");
        return;
      }
      if (busy || stop.signal.aborted) return;
      busy = true;
      try {
        show("working", "Входим в Modelseed…");
        let account;
        if (action.kind === "retry") {
          account = await restoreModelseedAccount(userDataPath);
          if (!account) {
            show("login");
            return;
          }
        } else if (action.kind === "oauth") {
          flow = undefined;
          browser = new AbortController();
          show(
            "browser",
            "Завершите вход в открывшемся браузере. Приложение продолжит автоматически.",
          );
          account = await browserLogin(
            action.provider,
            AbortSignal.any([stop.signal, browser.signal]),
          );
          browser = undefined;
        } else {
          let bundle;
          if (action.kind === "password") {
            if (
              !action.username.trim() ||
              action.username.length > 254 ||
              !action.password ||
              action.password.length > 1024
            ) {
              show("login", "Введите почту или имя пользователя и пароль.");
              return;
            }
            flow = undefined;
            bundle = await client.passwordLogin(
              action.username.trim(),
              action.password,
              stop.signal,
            );
          } else {
            if (!flow || !/^[A-Za-z0-9 -]{4,40}$/.test(action.code)) {
              show(flow ? "verify" : "login", "Проверьте код подтверждения.");
              return;
            }
            bundle = await client.verifyLogin(flow, action.code.trim(), stop.signal);
          }
          if (bundle.require_verification === true) {
            const totp =
              Array.isArray(bundle.methods) &&
              bundle.methods.some(
                (entry: unknown) =>
                  entry &&
                  typeof entry === "object" &&
                  "method" in entry &&
                  entry.method === "2fa" &&
                  "available" in entry &&
                  entry.available === true,
              );
            if (totp && typeof bundle.flow_token === "string") {
              flow = bundle.flow_token;
              show("verify", "Введите код из приложения для двухфакторной аутентификации.");
            } else {
              show("login", "Завершите проверку аккаунта в браузере.", true);
            }
            return;
          }
          flow = undefined;
          const verifier = secret();
          const code = await client.authorize(bundle, challengeFor(verifier), stop.signal);
          account = await client.exchange(code, verifier, stop.signal);
        }
        const active = await activateModelseedAccount(
          userDataPath,
          account,
          stop.signal,
          (message) => show("working", message),
        );
        if (!active) {
          show("login", "Срок действия входа истёк. Войдите снова.");
          return;
        }
        show("working", "Открываем рабочее пространство…");
        detach();
        resolve(true);
      } catch (error) {
        if (stop.signal.aborted) return;
        if (browser?.signal.aborted) {
          show("login");
          return;
        }
        const code = isModelseedAccountError(error) ? error.code : "";
        if (code === "browser_verification" || code === "password_disabled") {
          show("login", "Для этого аккаунта доступен вход через браузер.", true);
        } else if (action.kind === "verify" && code === "AUTH_FLOW_INVALID") {
          flow = undefined;
          show("login", "Срок действия проверки истёк. Войдите снова.");
        } else if (flow && action.kind === "verify") {
          show("verify", "Проверьте код и повторите попытку.");
        } else if (
          action.kind === "retry" ||
          code === "tools_unavailable" ||
          code === "storage_unavailable"
        ) {
          show("retry", errorText(error));
        } else if (
          action.kind === "password" &&
          isModelseedAccountError(error) &&
          error.status === 200
        ) {
          show("login", "Проверьте почту, имя пользователя или пароль.");
        } else {
          show("login", errorText(error));
        }
      } finally {
        browser = undefined;
        busy = false;
      }
    }

    accept = (action) => {
      void attempt(action);
    };
    void attempt({ kind: "retry" });
  });
}
