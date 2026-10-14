/**
 * One-command laptop run: boots a local Hardhat EVM with the full MetaMask
 * delegation framework (v1.3.0), deploys the custom enforcer and a 6-decimals
 * test USDC, seeds a mission-ready smart account, then starts the Next.js app
 * configured for that chain.
 *
 * Usage: npm run dev:local
 * Then open the printed URL and press "Create & start local mission", or run
 * `npm run demo:mission` in a second terminal.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import {
  bootstrapLocalChain,
  stopHardhatNode,
} from "../tests/harness/local-chain";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
  const nextLock = await readFile(new URL("../.next/dev/lock", import.meta.url), "utf8").catch(() => null);
  if (nextLock) {
    const lock = JSON.parse(nextLock) as { pid?: number; appUrl?: string };
    let running = false;
    if (lock.pid && Number.isInteger(lock.pid)) {
      try { process.kill(lock.pid, 0); running = true; }
      catch (error) { running = (error as NodeJS.ErrnoException).code === "EPERM"; }
    }
    if (running) throw new Error(`This project's app is already running at ${lock.appUrl ?? "its printed URL"}. Open it or stop it before starting a new chain.`);
  }
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`App port ${port} is busy. Open http://127.0.0.1:${port} or stop the existing app first.`)));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
  });
  console.log("Booting local Hardhat chain and deploying the framework…");
  const sessionId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const devContextFile = new URL(
    `../tests/harness/.chain-context.local-${sessionId}.json`,
    import.meta.url,
  );
  const boot = await bootstrapLocalChain({ contextFile: devContextFile });
  console.log(`Chain ready: ${boot.meta.rpcUrl} (chain id ${boot.meta.chainId})`);
  console.log(`Test USDC: ${boot.meta.tokenAddress}`);
  console.log(`MissionPolicyEnforcer: ${boot.meta.enforcerAddress}`);
  console.log(`User smart account: ${boot.meta.smartAccountAddress} (funded 10 USDC)`);

  const contextPath = fileURLToPath(devContextFile);
  const publicUrl = `http://127.0.0.1:${port}`;
  // Hardhat starts a fresh chain each time. Retain old journals in separate
  // files rather than displaying their receipts against a new chain.
  const configuredDb = process.env.DATABASE_PATH ?? "./data/swarm-tab.db";
  const dbPath = parse(configuredDb);
  const databasePath = configuredDb === ":memory:" ? configuredDb : join(
    dbPath.dir || "./data",
    `${dbPath.name}.local-${sessionId}${dbPath.ext || ".db"}`,
  );
  const hasDeepSeekKey = Boolean(process.env.DEEPSEEK_API_KEY);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SWARM_TAB_NETWORK: "local",
    LOCAL_CHAIN_CONTEXT: contextPath,
    SWARM_TAB_PUBLIC_URL: publicUrl,
    DATABASE_PATH: databasePath,
    ...(hasDeepSeekKey
      ? {}
      : { SWARM_TAB_FAKE_LLM: "1" }),
  };
  if (hasDeepSeekKey) {
    // Live DeepSeek mode: never let an inherited fixture flag leak into a run.
    delete env.SWARM_TAB_FAKE_LLM;
  }

  console.log(
    process.env.DEEPSEEK_API_KEY
      ? "DeepSeek: live mode (DEEPSEEK_API_KEY detected)"
      : "DeepSeek: fixture mode (SWARM_TAB_FAKE_LLM=1, clearly labelled in the UI)",
  );
  console.log(`Starting Next.js on ${publicUrl} …`);
  console.log(`Local session journal: ${databasePath}`);

  const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
  const next = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "-p", String(port)], {
    env,
    stdio: "inherit",
  });

  const shutdown = async (code: number) => {
    next.kill("SIGTERM");
    await stopHardhatNode(boot.process);
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  next.on("exit", (code) => void shutdown(code ?? 0));
}

main().catch(async (error) => {
  console.error("dev:local failed:", error);
  process.exitCode = 1;
});
