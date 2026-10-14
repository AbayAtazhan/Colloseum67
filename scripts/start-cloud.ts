/** Free standalone hackathon demo: Next production + private Hardhat + gateway.
 * No .env is loaded: cloud secrets come only from the hosting environment.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createCloudGateway, localJson } from "../src/hosting/gateway";

async function main() {
  const password = process.env.DEMO_ACCESS_PASSWORD ?? "";
  if (password.length < 16) throw new Error("Set DEMO_ACCESS_PASSWORD (at least 16 characters) in Render, not in the repository.");
  if (!process.env.DEEPSEEK_API_KEY && process.env.SWARM_TAB_FAKE_LLM !== "1") throw new Error("Set DEEPSEEK_API_KEY in Render. Fixture mode requires explicit SWARM_TAB_FAKE_LLM=1.");
  const port = Number(process.env.PORT ?? 10000);
  const appPort = Number(process.env.SWARM_TAB_INTERNAL_PORT ?? 3001);
  if (![port, appPort].every((value) => Number.isInteger(value) && value > 0 && value <= 65535) || port === appPort) throw new Error("Invalid server ports");
  const external = new URL(process.env.RENDER_EXTERNAL_URL ?? process.env.SWARM_TAB_HOSTED_URL ?? "");
  if (external.protocol !== "https:" && !(external.protocol === "http:" && ["127.0.0.1", "localhost"].includes(external.hostname))) throw new Error("Hosted URL must use HTTPS");
  if (external.username || external.password || external.pathname !== "/" || external.search || external.hash) throw new Error("Hosted URL must be a plain origin");
  // Bound child heaps on the 512 MB free instance. Do not apply this to builds.
  process.env.NODE_OPTIONS ??= "--max-old-space-size=128";
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  const session = randomUUID();
  const contextFile = new URL(`../data/chain-${session}.json`, import.meta.url);
  let node: ChildProcess | undefined;
  let deploy: ChildProcess | undefined;
  let next: ChildProcess | undefined;
  let stopping = false;
  let ready = false;
  // The gateway accepts connections during startup, but reports 503 until the
  // app and chain are ready. Private node and app ports bind only to loopback.
  const rpcUrl = "http://127.0.0.1:18546";
  const gateway = createCloudGateway({ appPort, rpcUrl, password, ready: () => ready });
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    ready = false;
    gateway.closeAllConnections();
    gateway.close();
    next?.kill("SIGTERM");
    deploy?.kill("SIGTERM");
    node?.kill("SIGTERM");
    await delay(300);
    for (const child of [next, deploy, node]) {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    process.exit(code);
  };
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  try {
    await new Promise<void>((resolve, reject) => {
      gateway.once("error", reject);
      gateway.listen(port, "0.0.0.0", resolve);
    });
    console.log("Starting hosted demo testnet (31338); state resets on server restart.");
    // Suppress Hardhat startup output (it prints well-known test private keys).
    node = spawn(fileURLToPath(new URL("../node_modules/.bin/hardhat", import.meta.url)), ["node", "--hostname", "127.0.0.1", "--port", "18546", "--chain-id", "31338"], { stdio: "ignore", env: { ...process.env, CHOKIDAR_USEPOLLING: "true" } });
    node.on("error", () => void shutdown(1));
    node.on("exit", () => { if (!stopping) void shutdown(1); });
    let chainReady = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (stopping) return;
      try {
        const response = await localJson(rpcUrl, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, 1000);
        if ((response.data as { result?: string }).result === "0x7a6a") { chainReady = true; break; }
      } catch { /* node is starting */ }
      await delay(500);
    }
    if (!chainReady) throw new Error("Hosted chain did not start");
    await new Promise<void>((resolve, reject) => {
      deploy = spawn(process.execPath, [fileURLToPath(new URL("./bootstrap-cloud.mjs", import.meta.url))], {
        env: { ...process.env, LOCAL_CHAIN_CONTEXT: fileURLToPath(contextFile), SWARM_TAB_PROJECT_ROOT: fileURLToPath(new URL("../", import.meta.url)), NODE_OPTIONS: "--max-old-space-size=192" }, stdio: "inherit",
      });
      deploy.on("error", reject);
      deploy.on("exit", (code) => code === 0 ? resolve() : reject(new Error("Hosted contracts could not be deployed")));
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      SWARM_TAB_NETWORK: "local",
      SWARM_TAB_HOSTED_DEMO: "1",
      LOCAL_CHAIN_CONTEXT: fileURLToPath(contextFile),
      DATABASE_PATH: fileURLToPath(new URL(`../data/demo-${session}.db`, import.meta.url)),
      // Self-calls stay on the private app port; the password never goes to
      // provider requests, DeepSeek, or a public gateway URL.
      SWARM_TAB_PUBLIC_URL: `http://127.0.0.1:${appPort}`,
      SWARM_TAB_WALLET_RPC_URL: `${external.origin}/rpc`,
    };
    if (env.DEEPSEEK_API_KEY) delete env.SWARM_TAB_FAKE_LLM;
    next = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url)), "start", "--hostname", "127.0.0.1", "-p", String(appPort)], { env, stdio: "inherit" });
    next.on("error", () => void shutdown(1));
    next.on("exit", (code) => { if (!stopping) void shutdown(code ?? 1); });
    for (let attempt = 0; attempt < 120; attempt++) {
      if (stopping) return;
      try {
        const response = await localJson(`http://127.0.0.1:${appPort}/api/health`, undefined, 1000);
        if (response.status === 200) { ready = true; break; }
      } catch { /* startup in progress */ }
      await delay(500);
    }
    if (!ready) throw new Error("Production app did not become ready");
    console.log(`Hosted demo ready: ${external.origin}; username demo. Access password is never logged.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Cloud startup failed");
    await shutdown(1);
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "Cloud startup failed"); process.exitCode = 1; });
