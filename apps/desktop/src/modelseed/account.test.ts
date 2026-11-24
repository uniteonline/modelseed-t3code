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

describe("Modelseed account authentication", () => {
  it("signs in using email and claims the app credentials without a pairing code", async () => {
    const signedIn = { ...session, user: { id: account.session.userId, role: 1 } };
    const client = createModelseedAccountClient(async (input, request) => {
      const target = new URL(String(input));
      expect(target.origin).toBe("https://console.modelseed.dev");
      const headers = new Headers(request?.headers);
      switch (target.pathname) {
        case "/api/status":
          return Response.json({ data: { password_login_enabled: true } });
        case "/api/user/login":
          expect(JSON.parse(String(request?.body))).toEqual({
            username: "tester@example.com",
            password: "test-password",
          });
          return Response.json({ data: signedIn });
        case "/api/installer/desktop/authorize":
          expect(headers.get("origin")).toBe(target.origin);
          expect(headers.get("authorization")).toBe("Bearer " + session.access_token);
          expect(headers.get("x-auth-session")).toBe(session.session.sid);
          expect(JSON.parse(String(request?.body))).toEqual({ challenge: "fixture-challenge" });
          return Response.json({ data: { code: "fixture-ticket" } });
        case "/api/user/auth/logout":
          return Response.json({ success: true });
        case "/api/installer/desktop/exchange":
          expect(JSON.parse(String(request?.body))).toEqual({
            code: "fixture-ticket",
            verifier: "fixture-verifier",
          });
          return Response.json({
            data: {
              device_code: "fixture-ack",
              device_id: account.deviceId,
              api_key: account.apiKey,
              key_expires_at: account.keyExpiresAt,
              session,
            },
          });
        case "/api/installer/device/ack":
          expect(JSON.parse(String(request?.body))).toEqual({
            device_code: "fixture-ack",
          });
          return Response.json({ success: true });
        default:
          throw new Error("Unexpected endpoint");
      }
    });
    const signedInBundle = await client.passwordLogin("tester@example.com", "test-password");
    const grant = await client.authorize(signedInBundle, "fixture-challenge");
    const pending = await client.exchange(grant, "fixture-verifier");
    expect(pending).toEqual({ ...account, pendingAck: "fixture-ack" });
    expect(await client.acknowledge(pending)).toEqual(account);
  });

  it("reads the balance and cumulative spend in Modelseed credits", async () => {
    const client = createModelseedAccountClient(async (input, request) => {
      expect(new URL(String(input)).pathname).toBe("/api/user/self");
      expect(new Headers(request?.headers).get("new-api-user")).toBe("42");
      return Response.json({
        data: { display_name: "Test account", quota: 625_000, used_quota: 500 },
      });
    });
    expect(await client.balance(account, async () => {})).toEqual({
      name: "Test account",
      balanceCredits: 1_250,
      usedCredits: 1,
    });
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
