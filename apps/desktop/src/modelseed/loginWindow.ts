import { BrowserWindow } from "electron";

const actionOrigin = "https://modelseed-login.invalid";
type Action = "start" | "browser" | "copy" | "retry";
interface LoginView {
  readonly status: string;
  readonly code?: string;
  readonly actions?: ReadonlyArray<{ readonly action: Action; readonly label: string }>;
}

export function modelseedLoginWindow(handleAction: (action: Action) => void) {
  const window = new BrowserWindow({
    title: "Modelseed T3 Code",
    width: 560,
    height: 475,
    minWidth: 450,
    minHeight: 420,
    backgroundColor: "#101713",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    event.preventDefault();
    const url = new URL(destination);
    if (url.origin !== actionOrigin) return;
    const action = url.pathname.slice(1);
    if (action === "start" || action === "browser" || action === "copy" || action === "retry") {
      handleAction(action);
    }
  });

  async function show(view: LoginView) {
    if (window.isDestroyed()) return;
    const escape = (text: string) =>
      text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const code = view.code
      ? '<output aria-label="Код подключения">' + escape(view.code) + "</output>"
      : "";
    const actions = (view.actions ?? [])
      .map(
        ({ action, label }) =>
          '<a href="' + actionOrigin + "/" + action + '">' + escape(label) + "</a>",
      )
      .join("");
    const markup = [
      '<!doctype html><html lang="ru"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">",
      "<title>Modelseed T3 Code</title><style>",
      "*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101713;color:#edf4ee;font:15px/1.55 'Segoe UI',sans-serif}",
      "main{width:min(100% - 48px,440px);padding:32px;border:1px solid #314438;border-radius:18px;background:#17221b}",
      "h1{margin:0 0 13px;font-size:26px;letter-spacing:-.45px}p{margin:0;color:#c9d6cb}output{display:block;margin-top:18px;font:700 26px/1.4 Consolas,monospace;letter-spacing:3px;color:#a4edb3}",
      "nav{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}nav:empty{display:none}a{display:inline-block;padding:9px 14px;border:1px solid #52715a;border-radius:8px;color:#e2f8e6;text-decoration:none;font-weight:600}",
      "a:first-child{background:#a4edb3;color:#122317;border-color:#a4edb3}a:hover{filter:brightness(1.1)}a:focus-visible{outline:2px solid #fff;outline-offset:3px}",
      '</style></head><body><main><h1>Вход в Modelseed</h1><p role="status">',
      escape(view.status),
      "</p>",
      code,
      '<nav aria-label="Действия">',
      actions,
      "</nav></main></body></html>",
    ].join("");
    try {
      await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(markup));
      if (!window.isDestroyed()) window.show();
    } catch (error) {
      // A newer status can replace an unfinished navigation.
      if (
        !window.isDestroyed() &&
        !(error instanceof Error && error.message.includes("ERR_ABORTED"))
      ) {
        throw error;
      }
    }
  }
  return { window, show };
}
