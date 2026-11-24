import { describe, expect, it } from "vite-plus/test";
import { createModelseedAccountClient, type DeviceAccount } from "./account.ts";
import { modelseedCatalog } from "./catalog.ts";

const session = {
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  access_expires_at: 2_100_000_000,
  user_id: 42,
  session: { sid: "fixture-session", expires_at: 2_200_000_000 },
};
const account = {
  deviceId: "fixture-device",
  keyExpiresAt: 2_200_000_000_000,
  apiKey: "test-api-key",
  session: {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    accessExpiresAt: session.access_expires_at,
    userId: session.user_id,
    sessionId: session.session.sid,
    sessionExpiresAt: session.session.expires_at,
  },
};

describe("Modelseed device authentication", () => {
  it("claims an approved account with a durable acknowledgement code", async () => {
    const routes: string[] = [];
    const client = createModelseedAccountClient(async (input, request) => {
      const target = new URL(String(input));
      expect(target.origin).toBe("https://console.modelseed.dev");
      expect(new Headers(request?.headers).get("origin")).toBe(target.origin);
      routes.push(target.pathname);
      switch (target.pathname.split("/").at(-1)) {
        case "start":
          expect(JSON.parse(String(request?.body))).toEqual({
            label: "T3 Code",
            platform: "windows-x64",
          });
          return Response.json({
            data: {
              device_code: "fixture-device-secret",
              user_code: "23456-ABCDE",
              expires_in: 600,
              interval: 5,
            },
          });
        case "poll":
          if (routes.length === 2)
            return Response.json({ data: { state: "pending" } }, { status: 202 });
          return Response.json({
            data: {
              state: "approved",
              device_id: account.deviceId,
              api_key: account.apiKey,
              key_expires_at: account.keyExpiresAt,
              session,
            },
          });
        case "ack":
          expect(JSON.parse(String(request?.body))).toEqual({
            device_code: "fixture-device-secret",
          });
          return Response.json({ success: true });
        default:
          throw new Error("Unexpected endpoint");
      }
    });
    const authorization = await client.start("T3 Code");
    expect(await client.poll(authorization)).toBeNull();
    const pending = await client.poll(authorization);
    expect(pending).toEqual({ ...account, pendingAck: "fixture-device-secret" });
    expect(await client.acknowledge(pending!)).toEqual(account);
  });

  it("recovers an expired access token and persists the rotated session before retrying", async () => {
    const persisted: DeviceAccount[] = [];
    const updated = {
      ...session,
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
    };
    const client = createModelseedAccountClient(async (input, request) => {
      const url = new URL(String(input));
      const headers = new Headers(request?.headers);
      if (url.pathname.endsWith("/refresh")) {
        expect(headers.get("x-auth-refresh-token")).toBe(session.refresh_token);
        return Response.json({ data: updated });
      }
      expect(headers.get("x-auth-renew")).toBe("1");
      if (headers.get("authorization") === "Bearer " + session.access_token) {
        return Response.json({}, { status: 401 });
      }
      expect(headers.get("authorization")).toBe("Bearer rotated-access");
      expect(persisted[0]?.session.refreshToken).toBe("rotated-refresh");
      return Response.json({ data: [{ id: account.deviceId, state: "active" }] });
    });
    await client.verify(account, async (value) => {
      persisted.push(value);
    });
    expect(persisted).toHaveLength(1);
  });

  it("intersects account models with the inference protocols each tool supports", () => {
    expect(
      modelseedCatalog(
        ["gpt-6.2-sol", "claude opus 5.5", "shared-model", "gpt-image-test", "video-model"],
        [
          {
            model_name: "shared-model",
            supported_endpoint_types: ["openai-response", "anthropic"],
          },
          { model_name: "unavailable-model", supported_endpoint_types: ["anthropic"] },
        ],
      ),
    ).toEqual({
      codexModels: ["gpt-6.2-sol", "shared-model"],
      claudeModels: ["claude opus 5.5", "shared-model"],
    });
  });
});
