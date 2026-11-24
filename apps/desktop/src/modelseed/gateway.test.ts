// @effect-diagnostics globalFetch:off -- Use the same HTTP streaming implementation as the desktop relay.
import { expect, it } from "vite-plus/test";
import { startModelseedGateway } from "./gateway.ts";

it("streams to the fixed Modelseed endpoint and substitutes the device key only upstream", async () => {
  const seen: string[] = [];
  const gateway = await startModelseedGateway("fixture-api-key", async (input, request) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.modelseed.dev");
    const headers = new Headers(request?.headers);
    expect(headers.get("authorization")).toBe("Bearer fixture-api-key");
    expect(headers.get("accept-language")).toBe("ru");
    expect(headers.has("x-api-key")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    if (url.pathname === "/v1/messages") {
      expect(headers.get("user-agent")).toBe("native-client-test/1.0");
      expect(headers.get("x-app")).toBe("cli");
    } else {
      expect(headers.get("user-agent")).not.toBe("native-client-test/1.0");
      expect(headers.has("x-app")).toBe(false);
    }
    seen.push(url.pathname);
    if (request?.method === "POST")
      expect(await new Response(request.body).json()).toEqual({ stream: true });
    return new Response("data: fixture\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  try {
    expect((await fetch(gateway.origin + "/v1/models")).status).toBe(401);
    const auth = { Authorization: "Bearer " + gateway.token };
    expect((await fetch(gateway.origin + "/api/user/self", { headers: auth })).status).toBe(404);
    expect((await fetch(gateway.origin + "/models", { headers: auth })).status).toBe(200);
    for (const path of ["/v1/responses", "/v1/messages"]) {
      const response = await fetch(gateway.origin + path, {
        method: "POST",
        headers: {
          ...auth,
          "User-Agent": "native-client-test/1.0",
          "X-App": "cli",
          "X-Api-Key": "fixture-local-only",
          Cookie: "local=fixture",
        },
        body: JSON.stringify({ stream: true }),
      });
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(await response.text()).toBe("data: fixture\n\n");
    }
    expect(seen).toEqual(["/v1/models", "/v1/responses", "/v1/messages"]);
  } finally {
    gateway.close();
  }
});
