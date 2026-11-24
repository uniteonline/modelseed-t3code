/* oxlint-disable t3code/no-untranslated-copy -- Modelseed Windows edition uses Russian. */
import { useEffect, useEffectEvent, useRef, useState, type SubmitEvent } from "react";
import { createRoot } from "react-dom/client";
import { GithubIcon, LoaderCircleIcon, SendIcon } from "lucide-react";
import type { DesktopBridge, ModelseedLoginAction, ModelseedLoginStatus } from "@t3tools/contracts";
import "@fontsource-variable/inter";
import "../index.css";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Login = NonNullable<DesktopBridge["modelseedLogin"]>;

function LoginScreen({
  login,
  initialStatus,
  ready,
}: {
  login: Login;
  initialStatus: ModelseedLoginStatus;
  ready: () => void;
}) {
  const [status, setStatus] = useState(initialStatus);
  const submitting = useRef(false);
  const { screen, message, allowBrowser } = status;

  async function send(action: ModelseedLoginAction) {
    if (submitting.current) return;
    submitting.current = true;
    try {
      const next = await login(action);
      if (next.screen === "ready") ready();
      else setStatus(next);
    } catch {
      setStatus({ screen: "retry", message: "Не удалось проверить вход. Повторите попытку." });
    } finally {
      submitting.current = false;
    }
  }

  const pollStatus = useEffectEvent(() => void send({ kind: "status" }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read pending login status from Electron until it reaches a user action or the workspace.
  useEffect(() => {
    if (screen !== "working" && screen !== "browser") return;
    const timer = window.setInterval(() => pollStatus(), 350);
    return () => window.clearInterval(timer);
  }, [screen]);

  const submitPassword = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void send({
      kind: "password",
      username: String(fields.get("username") ?? ""),
      password: String(fields.get("password") ?? ""),
    });
  };
  const submitVerification = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void send({ kind: "verify", code: String(fields.get("code") ?? "") });
  };

  return (
    <main className="dark modelseed-login fixed inset-0 overflow-auto bg-background text-foreground">
      <div aria-hidden="true" className="drag-region fixed inset-x-0 top-0 z-10 h-10" />
      <div className="flex min-h-full items-center justify-center px-5 py-12">
        <section
          aria-labelledby="modelseed-login-heading"
          className="w-full max-w-[390px] rounded-2xl border border-border bg-card p-8 shadow-xl shadow-black/15"
        >
          <div className="mb-7 flex items-center gap-3">
            <img src="/apple-touch-icon.png" alt="" className="size-10 rounded-xl" />
            <p className="text-sm font-semibold">Modelseed T3 Code</p>
          </div>
          <h1 id="modelseed-login-heading" className="mb-5 text-2xl font-semibold tracking-tight">
            {screen === "verify" ? "Подтверждение входа" : "Вход в Modelseed"}
          </h1>
          {message ? (
            <p role="status" className="mb-4 text-sm leading-relaxed text-muted-foreground">
              {message}
            </p>
          ) : null}
          {screen === "login" ? (
            <>
              <form onSubmit={submitPassword} className="grid gap-4">
                <label className="grid gap-1.5 text-sm">
                  Электронная почта или логин
                  <Input name="username" autoComplete="username" required maxLength={254} />
                </label>
                <label className="grid gap-1.5 text-sm">
                  Пароль
                  <Input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={1024}
                  />
                </label>
                <Button type="submit">Войти</Button>
              </form>
              <div className="mt-5 grid grid-cols-2 gap-2.5 border-t border-border pt-5">
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => void send({ kind: "oauth", provider: "github" })}
                >
                  <GithubIcon aria-hidden="true" /> GitHub
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => void send({ kind: "oauth", provider: "telegram" })}
                >
                  <SendIcon aria-hidden="true" /> Telegram
                </Button>
              </div>
              {allowBrowser ? (
                <Button
                  className="mt-3 w-full"
                  variant="outline"
                  type="button"
                  onClick={() => void send({ kind: "oauth", provider: "account" })}
                >
                  Подтвердить вход в браузере
                </Button>
              ) : null}
            </>
          ) : null}
          {screen === "verify" ? (
            <form onSubmit={submitVerification} className="grid gap-4">
              <label className="grid gap-1.5 text-sm">
                Код подтверждения
                <Input name="code" autoComplete="one-time-code" required maxLength={40} />
              </label>
              <Button type="submit">Подтвердить</Button>
              <Button type="button" variant="ghost" onClick={() => void send({ kind: "cancel" })}>
                Назад
              </Button>
            </form>
          ) : null}
          {screen === "working" || screen === "browser" ? (
            <LoaderCircleIcon
              aria-hidden="true"
              className="size-5 text-primary motion-safe:animate-spin"
            />
          ) : null}
          {screen === "browser" ? (
            <Button
              className="mt-4"
              type="button"
              variant="outline"
              onClick={() => void send({ kind: "cancel" })}
            >
              Отменить
            </Button>
          ) : null}
          {screen === "retry" ? (
            <Button type="button" variant="outline" onClick={() => void send({ kind: "retry" })}>
              Повторить
            </Button>
          ) : null}
        </section>
      </div>
    </main>
  );
}

export async function mountModelseedLogin(login: Login) {
  const initialStatus = await login({ kind: "status" });
  if (initialStatus.screen === "ready") return;
  const element = document.getElementById("root");
  if (!element) throw new Error("Modelseed login root is missing.");
  const root = createRoot(element);
  try {
    await new Promise<void>((ready) =>
      root.render(<LoginScreen login={login} initialStatus={initialStatus} ready={ready} />),
    );
  } finally {
    root.unmount();
  }
}
