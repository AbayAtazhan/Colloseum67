import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { authorizedSession, createCloudGateway, demoSession, safeRpcRequest } from "@/hosting/gateway";

const servers: Server[] = [];
const password = "test-only-cloud-password";
const authorization = `Basic ${Buffer.from(`demo:${password}`).toString("base64")}`;
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});

describe("public cloud gateway", () => {
  it("issues a secure session only after correct same-origin login, without leaking credentials upstream", async () => {
    const app = await listen(createServer((req, res) => { res.end(JSON.stringify({ cookie: req.headers.cookie ?? null, auth: req.headers.authorization ?? null })); }));
    const gateway = await listen(createCloudGateway({ appPort: Number(new URL(app).port), rpcUrl: app, password, ready: () => true }));
    const login = await fetch(gateway);
    expect(login.url).toBe(`${gateway}/login`);
    expect(await login.text()).toContain("Demo access password");
    const post = (supplied: string, origin = gateway) => fetch(`${gateway}/login`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({password: supplied}), redirect: "manual" });
    expect((await post(password, "https://attacker.example")).status).toBe(403);
    const wrong = await post("wrong");
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(await wrong.text()).toContain("Incorrect password");
    const good = await post(password);
    expect(good.status).toBe(303);
    const cookie = good.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Strict");
    const headers = {cookie: cookie.split(";")[0]};
    expect(await (await fetch(gateway, { headers })).json()).toEqual({cookie: null, auth: null});
    expect((await fetch(`${gateway}/api/missions`, { method: "POST", headers })).status).toBe(403);
    expect((await fetch(`${gateway}/api/missions`, { method: "POST", headers: {...headers,origin:gateway} })).status).toBe(200);
    expect(authorizedSession(`swarm_demo_session=${demoSession(password,Math.floor(Date.now()/1000)-1)}`,password)).toBe(false);
    expect(authorizedSession(`swarm_demo_session=${demoSession(password)}x`,password)).toBe(false);
    expect(authorizedSession(headers.cookie,"wrong-password")).toBe(false);
    const script = await fetch(`${gateway}/login.js`);
    expect(script.headers.get("content-type")).toContain("application/javascript");
    expect(await script.text()).toContain("credentials:'same-origin'");
    const interactive = await fetch(`${gateway}/login`, { method: "POST", headers: {origin:gateway,accept:"application/json"},body:new URLSearchParams({password}) });
    expect(interactive.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Strict");
    expect(await interactive.json()).toEqual({authenticated:true});
  });
  it("protects paid app routes and never forwards the access password", async () => {
    let upstreamHits = 0;
    const app = await listen(createServer((req, res) => {
      upstreamHits++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ auth: req.headers.authorization ?? null, path: req.url, host: req.headers.host }));
    }));
    const gateway = await listen(createCloudGateway({ appPort: Number(new URL(app).port), rpcUrl: app, password, ready: () => true }));
    expect((await fetch(`${gateway}/api/missions`, { method: "POST" })).status).toBe(401);
    expect(upstreamHits).toBe(0);
    const valid = await fetch(`${gateway}/api/missions`, { method: "POST", headers: { authorization, "content-type": "application/json", "x-forwarded-host": "evil.example" }, body: "{}" });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ auth: null, path: "/api/missions", host: new URL(app).host });
    expect(upstreamHits).toBe(1);
  });

  it("only exposes read RPC; rejects reset, broadcast, batches and state overrides", async () => {
    let calls = 0;
    const rpc = await listen(createServer((req, res) => { calls++; req.resume(); res.setHeader("content-type", "application/json"); res.end('{"jsonrpc":"2.0","id":1,"result":"0x7a6a"}'); }));
    const gateway = await listen(createCloudGateway({ appPort: 1, rpcUrl: rpc, password, ready: () => true }));
    const post = (value: unknown) => fetch(`${gateway}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    for (const method of ["hardhat_reset", "eth_sendTransaction", "eth_sendRawTransaction", "debug_traceCall", "personal_unlockAccount"]) {
      expect((await post({ jsonrpc: "2.0", id: 1, method, params: [] })).status).toBe(403);
    }
    expect((await post([{ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }])).status).toBe(403);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: `0x${"1".repeat(40)}` }, "latest", {}] })).status).toBe(403);
    expect(calls).toBe(0);
    const read = await post({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
    expect(read.status).toBe(200);
    expect((await read.json()).result).toBe("0x7a6a");
    expect(read.headers.get("access-control-allow-origin")).toBe("*");
    expect(calls).toBe(1);
  });

  it("limits call gas and refuses contract creation", () => {
    const request = { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: `0x${"1".repeat(40)}`, gas: "0xffffffffff" }, "latest"] };
    expect(safeRpcRequest(request)).toBe(true);
    expect((request.params[0] as { gas: string }).gas).toBe("0x7a120");
    expect(safeRpcRequest({ ...request, params: [{}] })).toBe(false);
  });

  it("keeps health public and gates app/RPC until startup finishes", async () => {
    const gateway = await listen(createCloudGateway({ appPort: 1, rpcUrl: "http://127.0.0.1:1", password, ready: () => false }));
    expect((await fetch(`${gateway}/api/health`)).status).toBe(503);
    expect((await fetch(gateway, { headers: { authorization } })).status).toBe(503);
    expect((await fetch(`${gateway}/rpc`, { method: "POST" })).status).toBe(503);
  });
});
