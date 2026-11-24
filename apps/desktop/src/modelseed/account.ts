// @effect-diagnostics globalDate:off -- Device expiry uses the account service's wall-clock time.
// @effect-diagnostics nodeBuiltinImport:off -- The desktop main process uses Windows' local crypto runtime.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

export const MODELSEED_CONSOLE = "https://console.modelseed.dev";
export const MODELSEED_API = "https://api.modelseed.dev";

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

  async function signIn(path: string, data: object, signal?: AbortSignal) {
    const { body } = await send(
      path,
      { method: "POST", headers: { Origin: MODELSEED_CONSOLE }, body: JSON.stringify(data) },
      signal,
    );
    return object(body.data);
  }

  function loginHeaders(bundle: Record<string, unknown>) {
    const user = object(bundle.user);
    if (positiveInt(user.role) >= 10) throw ModelseedAccountError.new(403, "access_denied");
    return {
      Origin: MODELSEED_CONSOLE,
      Authorization: "Bearer " + text(bundle.access_token, tokenPattern),
      "X-Auth-Session": text(object(bundle.session).sid, idPattern),
      "New-Api-User": String(positiveInt(user.id)),
    };
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
    async passwordLogin(username: string, password: string, signal?: AbortSignal) {
      const { body } = await send("/api/status", {}, signal);
      const flags = object(body.data);
      if (flags.turnstile_check === true)
        throw ModelseedAccountError.new(400, "browser_verification");
      if (flags.password_login_enabled === false)
        throw ModelseedAccountError.new(400, "password_disabled");
      let fields: { password: string } | { password_encrypted: string; encryption_key_id: string } =
        { password };
      if (flags.password_login_encryption_enabled === true) {
        const { body } = await send("/api/user/login/encryption-key", {}, signal);
        const keyData = object(body.data);
        const kid = text(keyData.kid, tokenPattern);
        if (typeof keyData.public_key !== "string" || keyData.public_key.length > 4096)
          throw ModelseedAccountError.new(502, "invalid_response");
        const key = NodeCrypto.createPublicKey(keyData.public_key);
        const plaintext = Buffer.from(password, "utf8");
        const options = {
          key,
          padding: NodeCrypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        };
        let encrypted: string;
        if (plaintext.length <= (key.asymmetricKeyDetails?.modulusLength ?? 0) / 8 - 66) {
          encrypted = NodeCrypto.publicEncrypt(options, plaintext).toString("base64");
        } else {
          const secret = NodeCrypto.randomBytes(32);
          const nonce = NodeCrypto.randomBytes(12);
          const cipher = NodeCrypto.createCipheriv("aes-256-gcm", secret, nonce);
          cipher.setAAD(Buffer.from(`password-v2:${kid}`));
          const payload = Buffer.concat([
            cipher.update(plaintext),
            cipher.final(),
            cipher.getAuthTag(),
          ]);
          const wrapped = NodeCrypto.publicEncrypt(
            { ...options, oaepLabel: Buffer.from("password-v2") },
            secret,
          );
          encrypted = [
            "v2",
            ...[wrapped, nonce, payload].map((chunk) => chunk.toString("base64")),
          ].join(".");
        }
        fields = { password_encrypted: encrypted, encryption_key_id: kid };
      }
      return signIn("/api/user/login", { username, ...fields }, signal);
    },
    verifyLogin(flowToken: string, code: string, signal?: AbortSignal) {
      return signIn(
        "/api/user/login/verify",
        { flow_token: flowToken, method: "2fa", code },
        signal,
      );
    },
    async authorize(bundle: Record<string, unknown>, challenge: string, signal?: AbortSignal) {
      const headers = loginHeaders(bundle);
      try {
        const result = await send(
          "/api/installer/desktop/authorize",
          { method: "POST", headers, body: JSON.stringify({ challenge }) },
          signal,
        );
        return text(object(result.body.data).code, idPattern);
      } finally {
        // Release the initial password session after the app has its own authorization.
        void send("/api/user/auth/logout", { method: "POST", headers, body: "{}" }).catch(
          () => undefined,
        );
      }
    },
    async exchange(code: string, verifier: string, signal?: AbortSignal): Promise<DeviceAccount> {
      const data = await signIn("/api/installer/desktop/exchange", { code, verifier }, signal);
      return {
        deviceId: text(data.device_id, idPattern),
        apiKey: text(data.api_key, tokenPattern),
        keyExpiresAt: positiveInt(data.key_expires_at),
        session: parseSession(data.session),
        pendingAck: text(data.device_code, idPattern),
      };
    },
    async balance(
      account: DeviceAccount,
      persist: (updated: DeviceAccount) => Promise<void>,
      signal?: AbortSignal,
    ) {
      const user = object(await withAccount("/api/user/self", account, persist, undefined, signal));
      const amount = (value: unknown) => {
        if (typeof value !== "number" || !Number.isFinite(value))
          throw ModelseedAccountError.new(502, "invalid_response");
        return value;
      };
      const name = [user.display_name, user.username, user.email].find(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      );
      return {
        name: name ?? "Modelseed",
        balanceCredits: amount(user.quota) / 500,
        usedCredits: amount(user.used_quota) / 500,
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
    async rubleRate() {
      const { body } = await send(
        "/fx.json",
        {},
        AbortSignal.timeout(4_000),
        "https://modelseed.dev",
      );
      const rate = object(body.rates).RUB;
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
        throw ModelseedAccountError.new(502, "invalid_response");
      }
      return rate;
    },
  };
}
