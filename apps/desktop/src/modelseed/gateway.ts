// @effect-diagnostics nodeBuiltinImport:off -- The loopback relay forwards native request and response streams.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import { MODELSEED_API } from "./account.ts";

const routes: Readonly<Record<string, ReadonlySet<string>>> = {
  GET: new Set(["/v1/models", "/models"]),
  POST: new Set([
    "/v1/responses",
    "/v1/responses/compact",
    "/v1/messages",
    "/v1/messages/count_tokens",
  ]),
};
const requestHeaders = [
  "accept",
  "content-type",
  "anthropic-beta",
  "anthropic-version",
  "idempotency-key",
];
const responseHeaders = ["content-type", "retry-after", "request-id", "x-request-id"];

function respond(res: NodeHttp.ServerResponse, status: number, type: string, message: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

export async function startModelseedGateway(apiKey: string, request: typeof fetch = fetch) {
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  async function relay(req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) {
    const path = req.url?.split("?", 1)[0] ?? "";
    if (!routes[req.method ?? ""]?.has(path)) {
      respond(res, 404, "not_found_error", "Этот путь API недоступен.");
      return;
    }
    if (req.headers.authorization !== "Bearer " + token && req.headers["x-api-key"] !== token) {
      respond(res, 401, "authentication_error", "Перезапустите Modelseed и войдите в аккаунт.");
      return;
    }
    const url = new URL(req.url ?? path, MODELSEED_API);
    if (url.pathname === "/models") url.pathname = "/v1/models";
    const headers = new Headers({ Authorization: "Bearer " + apiKey, "Accept-Language": "ru" });
    for (const name of requestHeaders) {
      const values = req.headers[name];
      if (values !== undefined)
        headers.set(name, Array.isArray(values) ? values.join(", ") : values);
    }
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    const options: RequestInit & { duplex?: "half" } = {
      method: req.method ?? "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
      ...(req.method === "POST"
        ? { body: NodeStream.Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" }
        : {}),
    };
    const upstream = await request(url, options);
    for (const name of responseHeaders) {
      const value = upstream.headers.get(name);
      if (value !== null) res.setHeader(name, value);
    }
    res.statusCode = upstream.status;
    res.flushHeaders();
    if (!upstream.body) {
      res.end();
      return;
    }
    const body = upstream.body as unknown as Parameters<typeof NodeStream.Readable.fromWeb>[0];
    await NodeStreamPromises.pipeline(NodeStream.Readable.fromWeb(body), res, {
      signal: controller.signal,
    });
  }
  const server = NodeHttp.createServer((req, res) => {
    void relay(req, res).catch(() => {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      respond(res, 502, "api_error", "Не удалось связаться с Modelseed. Повторите попытку.");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("modelseed_gateway_unavailable");
  return {
    token,
    origin: "http://127.0.0.1:" + address.port,
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}
