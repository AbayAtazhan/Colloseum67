import { ERC20TransferAmountEnforcer } from "@metamask/delegation-abis";
import { erc20Abi, type Address, type Hex } from "viem";
import type { ReadClient } from "./clients";

/** Reads the cumulative spend of a delegation from the official enforcer. */
export async function readDelegationSpent(params: {
  publicClient: ReadClient;
  enforcerAddress: Address;
  delegationManager: Address;
  delegationHash: Hex;
}): Promise<bigint> {
  return params.publicClient.readContract({
    address: params.enforcerAddress,
    abi: ERC20TransferAmountEnforcer,
    functionName: "spentMap",
    args: [params.delegationManager, params.delegationHash],
  });
}

export async function readTokenBalance(params: {
  publicClient: ReadClient;
  token: Address;
  account: Address;
}): Promise<bigint> {
  return params.publicClient.readContract({
    address: params.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [params.account],
  });
}

export async function readTokenMetadata(params: {
  publicClient: ReadClient;
  token: Address;
}): Promise<{ symbol: string; decimals: number }> {
  const [symbol, decimals] = await Promise.all([
    params.publicClient.readContract({
      address: params.token,
      abi: erc20Abi,
      functionName: "symbol",
    }),
    params.publicClient.readContract({
      address: params.token,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  ]);
  return { symbol, decimals };
}
