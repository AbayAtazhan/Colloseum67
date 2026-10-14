import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Chain,
} from "viem";
import { mnemonicToAccount, type LocalAccount } from "viem/accounts";
import { baseSepolia, hardhat } from "viem/chains";
import type { SmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { parseAmount } from "@/shared/amounts";
import { SetupRequiredError } from "@/shared/errors";
import type { ProviderId, TokenInfo } from "@/shared/types";
import { createProviderDefinitions } from "@/providers/data";
import type {
  ProviderDefinition,
  ProviderExecutionContext,
} from "@/providers/types";
import { RelayerQueue } from "@/x402/facilitator";
import { toCaip2 } from "@/x402/requirements";
import type { BoundWalletClient, ReadClient } from "./clients";
import {
  loadServerConfig,
  requireDeployerAccount,
  requireExecutorAccount,
  requireOwnerAccount,
  requireRecipients,
  requireRelayerAccount,
} from "./config";
import {
  loadLocalChainContext,
  localChainFromContext,
  type LocalChainContext,
} from "./local-context";
import { resolveSmartAccountsEnvironment } from "./network";

/** Deterministic Hardhat test accounts; local mode only, never production. */
export const LOCAL_TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

const LOCAL_INDEX = { owner: 0, executor: 1, relayer: 6 } as const;

export interface RuntimeConfig {
  mode: "local" | "base-sepolia";
  chainId: number;
  network: `${string}:${number}`;
  rpcUrl: string;
  token: TokenInfo;
  budget: bigint;
  perCallMax: bigint;
  recipients: Address[];
  validitySeconds: number;
  enforcerAddress: Address | null;
  budgetEnforcerAddress: Address;
  databasePath: string;
  executorAddress: Address | null;
  relayerAddress: Address | null;
  deployerAddress: Address | null;
  ownerAddress: Address | null;
  hasDeepSeekKey: boolean;
  fakeLlm: boolean;
  explorerBaseUrl: string | null;
  providerPayTo: Record<ProviderId, Address>;
}

export interface AppRuntime {
  config: RuntimeConfig;
  local: LocalChainContext | null;
  environment: SmartAccountsEnvironment;
  publicClient: ReadClient;
  chain: Chain;
  executor: LocalAccount | null;
  executorWallet: BoundWalletClient | null;
  relayer: LocalAccount | null;
  relayerWallet: BoundWalletClient | null;
  deployer: LocalAccount | null;
  deployerWallet: BoundWalletClient | null;
  owner: LocalAccount | null;
  ownerWallet: BoundWalletClient | null;
  relayerQueue: RelayerQueue | null;
  providers: Record<ProviderId, ProviderDefinition>;
  providerContext: ProviderExecutionContext;
}

let cachedRuntime: AppRuntime | null = null;

export function loadAppRuntime(env: NodeJS.ProcessEnv = process.env): AppRuntime {
  if (env === process.env && cachedRuntime) return cachedRuntime;
  const runtime =
    env.SWARM_TAB_NETWORK === "local" ? loadLocalRuntime(env) : loadBaseSepoliaRuntime(env);
  if (env === process.env) cachedRuntime = runtime;
  return runtime;
}

export function resetRuntimeCache(): void {
  cachedRuntime = null;
}

function walletFor(
  chain: Chain,
  rpcUrl: string,
  account: LocalAccount,
): BoundWalletClient {
  return createWalletClient({
    chain,
    transport: http(rpcUrl),
    account,
  }) as BoundWalletClient;
}

function loadLocalRuntime(env: NodeJS.ProcessEnv): AppRuntime {
  const local = loadLocalChainContext(env.LOCAL_CHAIN_CONTEXT);
  const chain = localChainFromContext(local);
  const publicClient = createPublicClient({
    chain,
    transport: http(local.rpcUrl),
  }) as ReadClient;
  const owner = mnemonicToAccount(LOCAL_TEST_MNEMONIC, {
    addressIndex: LOCAL_INDEX.owner,
  });
  const executor = mnemonicToAccount(LOCAL_TEST_MNEMONIC, {
    addressIndex: LOCAL_INDEX.executor,
  });
  const relayer = mnemonicToAccount(LOCAL_TEST_MNEMONIC, {
    addressIndex: LOCAL_INDEX.relayer,
  });
  const deployer = mnemonicToAccount(LOCAL_TEST_MNEMONIC, {
    addressIndex: 5,
  });
  const token: TokenInfo = {
    address: getAddress(local.tokenAddress),
    symbol: "USDC",
    decimals: 6,
  };
  const budget = parseAmount(env.MISSION_BUDGET_USDC ?? "0.05", 6);
  const perCallMax = parseAmount(env.PER_CALL_MAX_USDC ?? "0.02", 6);
  const recipients = [getAddress(local.recipient1), getAddress(local.recipient2)];
  const [codePayTo, activityPayTo] = recipients as [Address, Address];
  const budgetEnforcerAddress =
    local.environment.caveatEnforcers.ERC20TransferAmountEnforcer;
  const providers = createProviderDefinitions({
    codePayTo,
    activityPayTo,
    chainId: local.chainId,
  });
  return {
    config: {
      mode: "local",
      chainId: local.chainId,
      network: toCaip2(local.chainId),
      rpcUrl: local.rpcUrl,
      token,
      budget,
      perCallMax,
      recipients,
      validitySeconds: Number(env.MISSION_VALIDITY_SECONDS ?? 86_400),
      enforcerAddress: getAddress(local.enforcerAddress),
      budgetEnforcerAddress,
      databasePath: env.DATABASE_PATH ?? "./data/swarm-tab.db",
      executorAddress: executor.address,
      relayerAddress: relayer.address,
      deployerAddress: deployer.address,
      ownerAddress: owner.address,
      hasDeepSeekKey: Boolean(env.DEEPSEEK_API_KEY),
      fakeLlm: env.SWARM_TAB_FAKE_LLM === "1",
      explorerBaseUrl: null,
      providerPayTo: { code: codePayTo, activity: activityPayTo, market: codePayTo, exit: activityPayTo },
    },
    local,
    environment: local.environment,
    publicClient,
    chain,
    executor,
    executorWallet: walletFor(chain, local.rpcUrl, executor),
    relayer,
    relayerWallet: walletFor(chain, local.rpcUrl, relayer),
    deployer,
    deployerWallet: walletFor(chain, local.rpcUrl, deployer),
    owner,
    ownerWallet: walletFor(chain, local.rpcUrl, owner),
    relayerQueue: new RelayerQueue(publicClient, relayer.address),
    providers,
    providerContext: {
      rpcUrl: local.rpcUrl,
      chainId: local.chainId,
      fetch,
    },
  };
}

function loadBaseSepoliaRuntime(env: NodeJS.ProcessEnv): AppRuntime {
  const config = loadServerConfig(env);
  const chain = baseSepolia;
  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  }) as ReadClient;
  const environment = resolveSmartAccountsEnvironment(config.chainId);
  const recipients = requireRecipients(config);
  if (recipients.length < 2) {
    throw new SetupRequiredError(
      "ALLOWED_RECIPIENT_1 and ALLOWED_RECIPIENT_2 must both be configured: each provider has its own fixed payee",
    );
  }
  const executor = config.executorPrivateKey
    ? requireExecutorAccount(config)
    : null;
  const owner = config.ownerPrivateKey ? requireOwnerAccount(config) : null;
  const relayer =
    config.relayerPrivateKey || executor
      ? requireRelayerAccount(config)
      : null;
  const deployer =
    config.deployerPrivateKey || executor
      ? requireDeployerAccount(config)
      : null;
  const budgetEnforcerAddress =
    environment.caveatEnforcers.ERC20TransferAmountEnforcer;
  const [codePayTo, activityPayTo] = recipients as [Address, Address];
  const providers = createProviderDefinitions({
    codePayTo,
    activityPayTo,
    chainId: config.chainId,
  });
  return {
    config: {
      mode: "base-sepolia",
      chainId: config.chainId,
      network: toCaip2(config.chainId),
      rpcUrl: config.rpcUrl,
      token: config.token,
      budget: config.budget,
      perCallMax: config.perCallMax,
      recipients,
      validitySeconds: config.validitySeconds,
      enforcerAddress: config.enforcerAddress,
      budgetEnforcerAddress,
      databasePath: config.databasePath,
      executorAddress: executor?.address ?? null,
      relayerAddress: relayer?.address ?? null,
      deployerAddress: deployer?.address ?? null,
      ownerAddress: owner?.address ?? null,
      hasDeepSeekKey: Boolean(env.DEEPSEEK_API_KEY),
      fakeLlm: env.SWARM_TAB_FAKE_LLM === "1",
      explorerBaseUrl: "https://sepolia.basescan.org",
      providerPayTo: { code: codePayTo, activity: activityPayTo, market: codePayTo, exit: activityPayTo },
    },
    local: null,
    environment,
    publicClient,
    chain,
    executor,
    executorWallet: executor ? walletFor(chain, config.rpcUrl, executor) : null,
    relayer,
    relayerWallet: relayer ? walletFor(chain, config.rpcUrl, relayer) : null,
    deployer,
    deployerWallet: deployer ? walletFor(chain, config.rpcUrl, deployer) : null,
    owner,
    ownerWallet: owner ? walletFor(chain, config.rpcUrl, owner) : null,
    relayerQueue: relayer ? new RelayerQueue(publicClient, relayer.address) : null,
    providers,
    providerContext: {
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
      fetch,
    },
  };
}

export function hardhatChainFor(rpcUrl: string): Chain {
  return {
    ...hardhat,
    rpcUrls: { default: { http: [rpcUrl] } },
  } as Chain;
}
