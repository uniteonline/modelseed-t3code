// @effect-diagnostics globalDate:off -- Device expiry uses the account service's wall-clock time.
import * as Schema from "effect/Schema";

const MODELSEED_CONSOLE = "https://console.modelseed.dev";
export const MODELSEED_API = "https://api.modelseed.dev";
export const MODELSEED_DEVICES = MODELSEED_CONSOLE + "/devices?lng=ru";

export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresAt: number;
  readonly interval: number;
}

export interface AccountSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: number;
  readonly sessionId: string;
  readonly sessionExpiresAt: number;
  readonly userId: number;
}

export interface DeviceAccount {
  readonly deviceId: string;
  readonly apiKey: string;
  readonly keyExpiresAt: number;
  readonly session: AccountSession;
  readonly pendingAck?: string | undefined;
}

export class ModelseedAccountError extends Schema.TaggedError<
  ModelseedAccountError,
  { readonly brand: unique symbol }
>()("ModelseedAccountError", { status: Schema.Number, code: Schema.String }) {
  static new(status: number, code: string) {
    return new ModelseedAccountError({ status, code });
  }
}

export const isModelseedAccountError = Schema.is(ModelseedAccountError);

function object(data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw ModelseedAccountError.new(502, "invalid_response");
  }
  return data as Record<string, unknown>;
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw ModelseedAccountError.new(502, "invalid_response");
  }
  return value;
}

function positiveInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw ModelseedAccountError.new(502, "invalid_response");
  }
  return value;
}

const tokenPattern = /^[A-Za-z0-9._~-]+$/;
const modelPattern = /^[\p{L}\p{N}][\p{L}\p{N}._/ +:[\]-]{0,127}$/u;
const idPattern = /^[A-Za-z0-9_-]+$/;

function parseSession(raw: unknown): AccountSession {
  const bundle = object(raw);
  const session = object(bundle.session);
  const parsed = {
    accessToken: text(bundle.access_token, tokenPattern),
    refreshToken: text(bundle.refresh_token, tokenPattern),
    accessExpiresAt: positiveInt(bundle.access_expires_at),
    sessionId: text(session.sid, idPattern),
    sessionExpiresAt: positiveInt(session.expires_at),
    userId: positiveInt(bundle.user_id),
  };
  if (parsed.accessExpiresAt > parsed.sessionExpiresAt) {
    throw ModelseedAccountError.new(502, "invalid_response");
  }
  return parsed;
}

export function readDeviceAccount(raw: unknown): DeviceAccount {
  const record = object(raw);
  const session = object(record.session);
  return {
    deviceId: text(record.deviceId, idPattern),
    apiKey: text(record.apiKey, tokenPattern),
    keyExpiresAt: positiveInt(record.keyExpiresAt),
    ...(record.pendingAck === undefined ? {} : { pendingAck: text(record.pendingAck, idPattern) }),
    session: parseSession({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
      access_expires_at: session.accessExpiresAt,
      session: { sid: session.sessionId, expires_at: session.sessionExpiresAt },
      user_id: session.userId,
    }),
  };
}

export function createModelseedAccountClient(request: typeof fetch = fetch) {
  async function send(
    path: string,
    options: RequestInit = {},
    signal?: AbortSignal,
    origin: string = MODELSEED_CONSOLE,
  ): Promise<{ body: Record<string, unknown>; headers: Headers }> {
    const timeout = AbortSignal.timeout(15_000);
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    headers.set("Accept-Language", "ru");
    headers.set("Cache-Control", "no-store");
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await request(new URL(path, origin), {
        ...options,
        headers,
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw ModelseedAccountError.new(0, "network_unavailable");
    }
    const data: unknown = await response.json().catch(() => null);
    if (
      !response.ok ||
      (data && typeof data === "object" && "success" in data && data.success === false)
    ) {
      const code = data && typeof data === "object" && "code" in data ? data.code : undefined;
      throw ModelseedAccountError.new(
        response.status,
        typeof code === "string" ? code : "service_unavailable",
      );
    }
    return { body: object(data), headers: response.headers };
  }

  function requestDevice(path: string, data: object, signal?: AbortSignal) {
    return send(
      "/api/installer/device/" + path,
      {
        method: "POST",
        headers: { Origin: MODELSEED_CONSOLE },
        body: JSON.stringify(data),
      },
      signal,
    );
  }

  async function refresh(account: DeviceAccount, signal?: AbortSignal): Promise<DeviceAccount> {
    const { body } = await send(
      "/api/user/auth/installer/refresh",
      {
        method: "POST",
        headers: {
          Origin: MODELSEED_CONSOLE,
          "X-Auth-Session": account.session.sessionId,
          "X-Auth-Refresh-Token": account.session.refreshToken,
        },
        body: "{}",
      },
      signal,
    );
    const session = parseSession(body.data);
    if (
      session.sessionId !== account.session.sessionId ||
      session.userId !== account.session.userId
    ) {
      throw ModelseedAccountError.new(502, "invalid_response");
    }
    return { ...account, session };
  }

  async function withAccount(
    path: string,
    account: DeviceAccount,
    persist: (updated: DeviceAccount) => Promise<void>,
    body?: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const sendAccount = (session: AccountSession) =>
      send(
        path,
        {
          headers: {
            Origin: MODELSEED_CONSOLE,
            Authorization: "Bearer " + session.accessToken,
            "New-Api-User": String(session.userId),
            "X-Auth-Session": session.sessionId,
            "X-Auth-Renew": "1",
          },
          ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        },
        signal,
      );
    let current = account;
    let response;
    try {
      response = await sendAccount(current.session);
    } catch (error) {
      if (!isModelseedAccountError(error) || error.status !== 401) throw error;
      current = await refresh(current, signal);
      await persist(current);
      response = await sendAccount(current.session);
    }
    const token = response.headers.get("x-auth-token");
    const expires = Number(response.headers.get("x-auth-expires-at"));
    if (
      response.headers.get("x-auth-session") === current.session.sessionId &&
      token &&
      tokenPattern.test(token) &&
      Number.isSafeInteger(expires) &&
      expires > current.session.accessExpiresAt &&
      expires <= current.session.sessionExpiresAt
    ) {
      await persist({
        ...current,
        session: { ...current.session, accessToken: token, accessExpiresAt: expires },
      });
    }
    return response.body.data;
  }

  return {
    async start(label: string, signal?: AbortSignal): Promise<DeviceAuthorization> {
      const { body } = await requestDevice("start", { platform: "windows-x64", label }, signal);
      const data = object(body.data);
      return {
        deviceCode: text(data.device_code, idPattern),
        userCode: text(
          data.user_code,
          /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/,
        ),
        expiresAt: Date.now() + positiveInt(data.expires_in) * 1000,
        interval: Math.max(5, positiveInt(data.interval)) * 1000,
      };
    },
    async poll(
      authorization: DeviceAuthorization,
      signal?: AbortSignal,
    ): Promise<DeviceAccount | null> {
      const { body } = await requestDevice(
        "poll",
        { device_code: authorization.deviceCode },
        signal,
      );
      const data = object(body.data);
      if (data.state === "pending") return null;
      if (data.state !== "approved") throw ModelseedAccountError.new(502, "invalid_response");
      return {
        deviceId: text(data.device_id, idPattern),
        apiKey: text(data.api_key, tokenPattern),
        keyExpiresAt: positiveInt(data.key_expires_at),
        session: parseSession(data.session),
        pendingAck: authorization.deviceCode,
      };
    },
    async acknowledge(account: DeviceAccount, signal?: AbortSignal): Promise<DeviceAccount> {
      if (!account.pendingAck) return account;
      await requestDevice("ack", { device_code: account.pendingAck }, signal);
      const { pendingAck: _pendingAck, ...active } = account;
      return active;
    },
    async verify(
      account: DeviceAccount,
      persist: (updated: DeviceAccount) => Promise<void>,
      signal?: AbortSignal,
    ) {
      if (
        account.keyExpiresAt <= Date.now() ||
        account.session.sessionExpiresAt * 1000 <= Date.now()
      ) {
        throw ModelseedAccountError.new(401, "session_expired");
      }
      const devices = await withAccount(
        "/api/installer/devices",
        account,
        persist,
        undefined,
        signal,
      );
      if (!Array.isArray(devices)) throw ModelseedAccountError.new(502, "invalid_response");
      if (!devices.some((device) => device?.id === account.deviceId && device.state === "active")) {
        throw ModelseedAccountError.new(403, "access_denied");
      }
    },
    async revoke(account: DeviceAccount, persist: (updated: DeviceAccount) => Promise<void>) {
      await withAccount("/api/installer/device/revoke", account, persist, { id: account.deviceId });
    },
    async models(apiKey: string, signal?: AbortSignal): Promise<string[]> {
      const { body } = await send(
        "/v1/models",
        {
          headers: { Authorization: "Bearer " + apiKey },
        },
        signal,
        MODELSEED_API,
      );
      if (!Array.isArray(body.data)) throw ModelseedAccountError.new(502, "invalid_response");
      return Array.from(
        new Set(
          body.data.flatMap((model: unknown) => {
            if (model === null || typeof model !== "object" || !("id" in model)) return [];
            return typeof model.id === "string" && modelPattern.test(model.id) ? [model.id] : [];
          }),
        ),
      );
    },
    async pricing(signal?: AbortSignal): Promise<unknown> {
      return (await send("/api/pricing", {}, signal)).body.data;
    },
  };
}
