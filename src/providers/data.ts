import {
  createPublicClient,
  http,
  keccak256,
  formatEther,
  type Address,
  type Hex,
} from "viem";
import type {
  ProviderDefinition,
  ProviderExecutionContext,
  ProviderRequestArgs,
  ProviderResult,
} from "./types";
import type { ProviderId } from "@/shared/types";
import { PROVIDER_PRICE, parseProviderArgs } from "./types";
import { fetchExitFacts, fetchMarketFacts, parseMarketArgs } from "./market";

/**
 * `code` provider: bytecode facts for an address at a fixed block.
 * Facts only: size, hash, prefix and contract presence. No owner, history or
 * risk inference.
 */
export async function fetchCodeFacts(
  args: ProviderRequestArgs,
  context: ProviderExecutionContext,
): Promise<ProviderResult> {
  const client = createPublicClient({
    transport: http(context.rpcUrl),
  });
  const observedBlock = args.blockNumber ?? Number(await client.getBlockNumber());
  const code = ((await client.getCode({
    address: args.address,
    blockNumber: BigInt(observedBlock),
  })) ?? "0x") as Hex;
  const codeSizeBytes = (code.length - 2) / 2;
  return {
    blockNumber: observedBlock,
    facts: {
      address: args.address,
      blockNumber: observedBlock,
      isContract: codeSizeBytes > 0,
      codeSizeBytes,
      codeHash: codeSizeBytes > 0 ? keccak256(code) : null,
      codePrefix: codeSizeBytes > 0 ? code.slice(0, 10) : null,
      chainId: context.chainId,
    },
  };
}

/**
 * `activity` provider: native balance and outgoing transaction count at a
 * fixed block. These are raw RPC values only.
 */
export async function fetchActivityFacts(
  args: ProviderRequestArgs,
  context: ProviderExecutionContext,
): Promise<ProviderResult> {
  const client = createPublicClient({
    transport: http(context.rpcUrl),
  });
  const observedBlock = args.blockNumber ?? Number(await client.getBlockNumber());
  const [balanceWei, transactionCount] = await Promise.all([
    client.getBalance({
      address: args.address,
      blockNumber: BigInt(observedBlock),
    }),
    client.getTransactionCount({
      address: args.address,
      blockNumber: BigInt(observedBlock),
    }),
  ]);
  return {
    blockNumber: observedBlock,
    facts: {
      address: args.address,
      blockNumber: observedBlock,
      nativeBalanceWei: balanceWei.toString(),
      nativeBalanceEth: formatEther(balanceWei),
      transactionCount,
      chainId: context.chainId,
    },
  };
}

export function createProviderDefinitions(config: {
  codePayTo: Address;
  activityPayTo: Address;
  chainId: number;
}): Record<ProviderId, ProviderDefinition> {
  const base = {
    price: PROVIDER_PRICE,
    parseArgs: parseProviderArgs,
  };
  return {
    market: {
      price: PROVIDER_PRICE, parseArgs: parseMarketArgs, id: "market",
      name: "Market comparison", description: "Current Base token liquidity and volume, normalized from DEX Screener with timestamps and sources.",
      path: "/api/providers/market", payTo: config.codePayTo, run: fetchMarketFacts,
    },
    exit: {
      price: PROVIDER_PRICE, parseArgs: parseMarketArgs, id: "exit",
      name: "Exit route comparison", description: "USD-sized indicative sell routes into Base USDC, including quoted proceeds, gas and data gaps.",
      path: "/api/providers/exit", payTo: config.activityPayTo, run: fetchExitFacts,
    },
    code: {
      ...base,
      id: "code",
      name: "Code facts",
      description:
        "Bytecode size, hash and prefix for an address at a fixed block of the configured chain.",
      path: "/api/providers/code",
      payTo: config.codePayTo,
      run: fetchCodeFacts,
    },
    activity: {
      ...base,
      id: "activity",
      name: "Activity facts",
      description:
        "Native balance and transaction count for an address at a fixed block of the configured chain.",
      path: "/api/providers/activity",
      payTo: config.activityPayTo,
      run: fetchActivityFacts,
    },
  };
}
