import { readFileSync } from "node:fs";
import { createPublicClient, http, type Address, type Chain } from "viem";
import { hardhat } from "viem/chains";
import type { SmartAccountsEnvironment } from "@metamask/smart-accounts-kit";

export interface LocalChainContext {
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
}

export const DEFAULT_LOCAL_CONTEXT_PATH = "tests/harness/.chain-context.json";

export function loadLocalChainContext(
  path = process.env.LOCAL_CHAIN_CONTEXT ?? DEFAULT_LOCAL_CONTEXT_PATH,
): LocalChainContext {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `local chain context not found at ${path}; run "npm run dev:local" (which boots the local chain first)`,
    );
  }
  return JSON.parse(raw) as LocalChainContext;
}

export function localChainFromContext(context: LocalChainContext): Chain {
  return {
    ...hardhat,
    id: context.chainId,
    rpcUrls: { default: { http: [context.rpcUrl] } },
  } as Chain;
}

export function localPublicClient(context: LocalChainContext) {
  return createPublicClient({
    chain: localChainFromContext(context),
    transport: http(context.rpcUrl),
  });
}
