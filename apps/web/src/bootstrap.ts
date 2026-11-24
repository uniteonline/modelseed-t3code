import { showBootError } from "./lib/bootError";

if (window.desktopBridge?.signOutModelseed) {
  document.documentElement.lang = "ru";
  const splashLabel = "Запуск Modelseed T3 Code";
  document.getElementById("boot-shell-card")?.setAttribute("aria-label", splashLabel);
}

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
void import("./main").then(({ startup }) => startup).catch(showBootError);
