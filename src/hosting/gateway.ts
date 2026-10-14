import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { loginPage, loginScript } from "./login-page";

/** Small loopback client: avoids loading a second HTTP stack in the gateway. */
export function localJson(url: string, payload?: unknown, timeout = 8000): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const request = httpRequest(url, {
      method: body === undefined ? "GET" : "POST", timeout,
      headers: body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_048_576) response.destroy(new Error("response_too_large"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve({ status: response.statusCode ?? 502, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("upstream_timeout")));
    request.on("error", reject);
    request.end(body);
  });
}

// The wallet can read the demo chain. Signing/broadcasting, unlocked Hardhat
// accounts, debug_* and hardhat_* are never exposed on the public port.
const READ_METHODS = new Set([
  "eth_chainId", "net_version", "web3_clientVersion", "eth_blockNumber",
  "eth_getBalance", "eth_getCode", "eth_getTransactionCount", "eth_call",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionByHash",
  "eth_getTransactionReceipt", "eth_gasPrice", "eth_maxPriorityFeePerGas",
]);

export function safeRpcRequest(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rpc = value as Record<string, unknown>;
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string" || !READ_METHODS.has(rpc.method)) return false;
  if (!Array.isArray(rpc.params) || rpc.params.length > 2) return false;
  if (!(typeof rpc.id === "string" || typeof rpc.id === "number" || rpc.id === null)) return false;
  if (rpc.method === "eth_call") {
    const call = rpc.params[0];
    if (!call || typeof call !== "object" || Array.isArray(call)) return false;
    const options = call as Record<string, unknown>;
    if (typeof options.to !== "string" || !/^0x[\da-f]{40}$/i.test(options.to)) return false;
    // Bound simulation cost; no state/block overrides or contract creation.
    options.gas = "0x7a120";
  }
  return true;
}

export function authorizedDemo(header: string | undefined, password: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const actual = createHash("sha256").update(Buffer.from(header.slice(6), "base64")).digest();
  const expected = createHash("sha256").update(`demo:${password}`).digest();
  return timingSafeEqual(actual, expected);
}

const SESSION_COOKIE = "swarm_demo_session";
const SESSION_SECONDS = 12 * 60 * 60;

export function demoSession(password: string, expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS): string {
  return `${expires}.${createHmac("sha256", password).update(`swarm-demo:${expires}`).digest("hex")}`;
}

export function authorizedSession(cookie: string | undefined, password: string): boolean {
  const value = cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!value || !/^\d{10}\.[\da-f]{64}$/.test(value)) return false;
  const expires = Number(value.split(".")[0]);
  const now = Math.floor(Date.now() / 1000);
  if (expires <= now || expires > now + SESSION_SECONDS) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(demoSession(password, expires)));
}

function sameOrigin(req: IncomingMessage): boolean {
  try {
    const origin = new URL(req.headers.origin ?? "");
    return origin.host === req.headers.host && (origin.protocol === "https:" || (origin.protocol === "http:" && origin.hostname === "127.0.0.1"));
  } catch { return false; }
}

function showLogin(res: ServerResponse, invalid = false): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  });
  res.end(loginPage(invalid));
}

async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 65_536) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

export function createCloudGateway(options: {
  appPort: number;
  rpcUrl: string;
  password: string;
  ready: () => boolean;
}) {
  if (options.password.length < 16) throw new Error("DEMO_ACCESS_PASSWORD must contain at least 16 characters");
  let rpcWindow = Date.now();
  let rpcCount = 0;
  return createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.url.length > 4096) return json(res, 400, { error: "invalid_url" });
      const path = new URL(req.url, "http://internal.invalid").pathname;
      if (path === "/rpc") {
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("access-control-allow-methods", "POST, OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type");
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
        if (req.method !== "POST") return json(res, 405, { error: "post_required" });
        if (!options.ready()) return json(res, 503, { error: "warming_up" });
        if (Date.now() - rpcWindow > 60_000) { rpcWindow = Date.now(); rpcCount = 0; }
        if (++rpcCount > 240) return json(res, 429, { error: "rpc_rate_limit" });
        const payload: unknown = JSON.parse((await bodyOf(req)).toString("utf8"));
        if (!safeRpcRequest(payload)) return json(res, 403, { error: "read_only_demo_rpc" });
        const upstream = await localJson(options.rpcUrl, payload);
        return json(res, upstream.status, upstream.data);
      }
      // Render's health checker requires an unauthenticated endpoint.
      if (path === "/api/health" && req.method === "GET") {
        return json(res, options.ready() ? 200 : 503, { status: options.ready() ? "ok" : "warming_up", deployment: "hosted-demo" });
      }
      if (path === "/login.js" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(loginScript);
        return;
      }
      if (path === "/login") {
        if (req.method === "GET") return showLogin(res);
        if (req.method !== "POST") return json(res, 405, { error: "post_required" });
        if (!sameOrigin(req)) return json(res, 403, { error: "invalid_origin" });
        const credentials = new URLSearchParams((await bodyOf(req)).toString("utf8"));
        const supplied = credentials.get("password") ?? "";
        const wantsJson = req.headers.accept?.includes("application/json");
        if (!authorizedDemo(`Basic ${Buffer.from(`demo:${supplied}`).toString("base64")}`, options.password)) return wantsJson ? json(res, 401, { error: "invalid_password" }) : showLogin(res, true);
        res.setHeader("set-cookie", `${SESSION_COOKIE}=${demoSession(options.password)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`);
        if (wantsJson) return json(res, 200, { authenticated: true });
        res.writeHead(303, { location: "/", "cache-control": "no-store" });
        res.end();
        return;
      }
      const basic = authorizedDemo(req.headers.authorization, options.password);
      const session = authorizedSession(req.headers.cookie, options.password);
      if (!basic && !session) {
        if (req.method === "GET" && !path.startsWith("/api/")) {
          res.writeHead(303, { location: "/login", "cache-control": "no-store" });
          res.end();
          return;
        }
        json(res, 401, { error: "login_required" });
        return;
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? "") && (!basic || req.headers.origin) && !sameOrigin(req)) return json(res, 403, { error: "invalid_origin" });
      if (!options.ready()) return json(res, 503, { error: "warming_up" });
      const body = await bodyOf(req);
      // Fixed loopback target: client headers cannot turn this into an open
      // proxy, spoof the internal origin, or leak Basic credentials upstream.
      const upstream = httpRequest({
        hostname: "127.0.0.1", port: options.appPort, path: req.url, method: req.method,
        headers: {
          ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
          ...(req.headers.accept ? { accept: req.headers.accept } : {}),
          "content-length": body.length,
        },
        timeout: 120_000,
      }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      upstream.on("timeout", () => upstream.destroy(new Error("upstream_timeout")));
      upstream.on("error", () => { if (!res.headersSent) json(res, 502, { error: "app_unavailable" }); else res.destroy(); });
      res.on("close", () => upstream.destroy());
      upstream.end(body);
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof Error && error.message === "request_too_large" ? 413 : 400, { error: "invalid_request" });
      else res.destroy();
    }
  });
}
