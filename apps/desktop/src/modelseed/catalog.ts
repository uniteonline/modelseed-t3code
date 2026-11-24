export function modelseedCatalog(models: ReadonlyArray<string>, pricing: unknown) {
  const routes = new Map<string, ReadonlyArray<unknown>>();
  if (Array.isArray(pricing)) {
    for (const row of pricing as ReadonlyArray<unknown>) {
      if (
        row !== null &&
        typeof row === "object" &&
        "model_name" in row &&
        typeof row.model_name === "string" &&
        "supported_endpoint_types" in row &&
        Array.isArray(row.supported_endpoint_types)
      ) {
        routes.set(row.model_name, row.supported_endpoint_types);
      }
    }
  }
  const codexModels: string[] = [];
  const claudeModels: string[] = [];
  for (const model of models) {
    const endpoints = routes.get(model);
    if (endpoints?.includes("openai-response") || /^(?:gpt-|codex-|o[1-9](?:-|$))/i.test(model)) {
      if (!/image|realtime|audio|speech|transcri|embedd|moderation|tts/i.test(model)) {
        codexModels.push(model);
      }
    }
    if (endpoints?.includes("anthropic") || /^claude[-/ ]/i.test(model)) {
      claudeModels.push(model);
    }
  }
  return { codexModels, claudeModels };
}
