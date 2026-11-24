import { showBootError } from "./lib/bootError";

async function boot() {
  const login = window.desktopBridge?.modelseedLogin;
  if (login) {
    document.documentElement.lang = "ru";
    const { mountModelseedLogin } = await import("./components/ModelseedLogin");
    await mountModelseedLogin(login);
  }
  // Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
  const { startup } = await import("./main");
  await startup;
}

void boot().catch(showBootError);
