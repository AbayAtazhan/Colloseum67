import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { mnemonicToAccount, type LocalAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { deploySmartAccountsEnvironment } from "@metamask/smart-accounts-kit/utils";
import type { SmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { createUserSmartAccount, deploySmartAccount } from "@/payments/accounts";
import type { BoundWalletClient, ReadClient } from "@/payments/clients";
import { loadArtifact, PROJECT_ROOT } from "./artifacts";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";

/** Default Hardhat mnemonic; accounts are deterministic and funded. */
export const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

export function testAccount(index: number): LocalAccount {
  return mnemonicToAccount(TEST_MNEMONIC, { addressIndex: index });
}

export const TEST_ACCOUNTS = {
  owner: 0,
  executor: 1,
  recipient1: 2,
  recipient2: 3,
  attacker: 4,
  deployer: 5,
  relayer: 6,
} as const;

export const CONTEXT_FILE = new URL(".chain-context.test.json", import.meta.url);

export interface ChainContextMeta {
  rpcUrl: string;
  chainId: number;
  environment: SmartAccountsEnvironment;
  enforcerAddress: Address;
  tokenAddress: Address;
  smartAccountAddress: Address;
  ownerAddress: Address;
  executorAddress: Address;
  recipient1: Address;
  recipient2: Address;
  attackerAddress: Address;
  relayerAddress: Address;
}

export interface BootstrappedChain {
  process: ChildProcessByStdio<null, Readable, Readable>;
  chain: Chain;
  meta: ChainContextMeta;
}

function localChain(rpcUrl: string, chainId = 31337): Chain {
  return {
    ...hardhat,
    id: chainId,
    rpcUrls: { default: { http: [rpcUrl] } },
  } as Chain;
}

async function waitForRpc(publicClient: ReadClient, child: BootstrappedChain["process"], expectedChainId = 31337): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Hardhat exited during startup");
    try {
      const chainId = await publicClient.getChainId();
      if (chainId === expectedChainId) return;
    } catch {
      // node is still starting
    }
    await delay(500);
  }
  throw new Error("Hardhat node did not become ready in 60s");
}

async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

export async function startHardhatNode(options?: {
  port?: number;
  chainId?: number;
}): Promise<{ process: ChildProcessByStdio<null, Readable, Readable>; chain: Chain; rpcUrl: string }> {
  const startPort = options?.port ?? 8546;
  const chainId = options?.chainId ?? 31337;
  for (let port = startPort; port < startPort + 20; port += 1) {
    // Never attach to another live dev/test node merely because its chain id matches.
    if (!(await portAvailable(port))) continue;
    const rpcUrl = `http://127.0.0.1:${port}`;
    const child = spawn(
      `${PROJECT_ROOT}node_modules/.bin/hardhat`,
      ["node", "--hostname", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId)],
      {
        cwd: PROJECT_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        // Poll only Hardhat's small build-info directory; native watchers can
        // exhaust macOS/sandbox handles even when file descriptor limits are high.
        env: { ...process.env, CHOKIDAR_USEPOLLING: "true" },
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    const publicClient = createPublicClient({
      chain: localChain(rpcUrl, chainId),
      transport: http(rpcUrl, { timeout: 500, retryCount: 0 }),
    }) as ReadClient;
    try {
      await waitForRpc(publicClient, child, chainId);
      return { process: child, chain: localChain(rpcUrl, chainId), rpcUrl };
    } catch {
      child.kill("SIGKILL");
    }
  }
  throw new Error(`could not start a Hardhat node on ports ${startPort}-${startPort + 19}`);
}

export async function bootstrapLocalChain(options?: {
  contextFile?: URL;
  port?: number;
  chainId?: number;
}): Promise<BootstrappedChain> {
  const { process: child, chain, rpcUrl } = await startHardhatNode(options);
  try {
    const meta = await deployLocalDemo({ chain, rpcUrl, contextFile: options?.contextFile });
    return { process: child, chain, meta };
  } catch (error) {
    await stopHardhatNode(child);
    throw error;
  }
}

/** Deployment can run in a short-lived process on memory-limited hosting. */
export async function deployLocalDemo(options: {
  chain: Chain;
  rpcUrl: string;
  contextFile?: URL;
}): Promise<ChainContextMeta> {
  const { chain, rpcUrl } = options;
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  }) as ReadClient;
  const deployer = testAccount(TEST_ACCOUNTS.deployer);
  const deployerWallet = createWalletClient({
    chain,
    transport: http(rpcUrl),
    account: deployer,
  }) as BoundWalletClient;

  // Full official framework: DelegationManager v1.3.0, enforcers, factories,
  // EntryPoint and the MetaMask delegator implementations, deployed from the
  // bytecode shipped in @metamask/delegation-abis.
  const environment = await deploySmartAccountsEnvironment(
    deployerWallet,
    publicClient,
    chain,
  );

  const enforcerArtifact = await loadArtifact(
    "MissionPolicyEnforcer.sol",
    "MissionPolicyEnforcer",
  );
  const enforcerHash = await deployerWallet.deployContract({
    abi: enforcerArtifact.abi,
    bytecode: enforcerArtifact.bytecode,
    args: [],
  });
  const enforcerReceipt = await publicClient.waitForTransactionReceipt({
    hash: enforcerHash,
  });
  if (!enforcerReceipt.contractAddress) {
    throw new Error("MissionPolicyEnforcer deployment failed");
  }

  const tokenArtifact = await loadArtifact("TestUSDC.sol", "TestUSDC");
  const tokenHash = await deployerWallet.deployContract({
    abi: tokenArtifact.abi,
    bytecode: tokenArtifact.bytecode,
    args: [6],
  });
  const tokenReceipt = await publicClient.waitForTransactionReceipt({
    hash: tokenHash,
  });
  if (!tokenReceipt.contractAddress) {
    throw new Error("TestUSDC deployment failed");
  }
  const tokenAddress = tokenReceipt.contractAddress;
  const enforcerAddress = enforcerReceipt.contractAddress;

  // Deploy the user's MetaMask Hybrid smart account (the delegator).
  const owner = testAccount(TEST_ACCOUNTS.owner);
  const smartAccount = await createUserSmartAccount({
    publicClient,
    owner,
    environment,
  });
  await deploySmartAccount({
    publicClient,
    walletClient: deployerWallet,
    smartAccount,
  });

  // Fund it with test USDC (10.00 USDC).
  const mintHash = await deployerWallet.writeContract({
    address: tokenAddress,
    abi: tokenArtifact.abi,
    functionName: "mint",
    args: [smartAccount.address, 10_000_000n],
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });

  // Fund it with ETH so owner-signed user operations (revocation) can pay the
  // EntryPoint prefund. On Base Sepolia a paymaster or the owner's ETH plays
  // this role.
  const fundHash = await deployerWallet.sendTransaction({
    to: smartAccount.address,
    value: parseEther("1"),
  });
  await publicClient.waitForTransactionReceipt({ hash: fundHash });

  const meta: ChainContextMeta = {
    rpcUrl,
    chainId: chain.id,
    environment,
    enforcerAddress,
    tokenAddress,
    smartAccountAddress: smartAccount.address,
    ownerAddress: testAccount(TEST_ACCOUNTS.owner).address,
    executorAddress: testAccount(TEST_ACCOUNTS.executor).address,
    recipient1: testAccount(TEST_ACCOUNTS.recipient1).address,
    recipient2: testAccount(TEST_ACCOUNTS.recipient2).address,
    attackerAddress: testAccount(TEST_ACCOUNTS.attacker).address,
    relayerAddress: testAccount(TEST_ACCOUNTS.relayer).address,
  };
  await writeFile(
    options.contextFile ?? CONTEXT_FILE,
    JSON.stringify(meta, null, 2),
    "utf8",
  );
  return meta;
}

export async function stopHardhatNode(
  child: ChildProcessByStdio<null, Readable, Readable> | null,
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await delay(300);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

export type { Address, Hex };
