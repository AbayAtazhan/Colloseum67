import { getAddress, type Address, type Chain } from "viem";
import { baseSepolia, hardhat } from "viem/chains";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import type { SmartAccountsEnvironment } from "@metamask/smart-accounts-kit";

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const LOCAL_CHAIN_ID = 31337;
/** Framework version deployed on Base Sepolia and preferred by the SDK. */
export const FRAMEWORK_VERSION = "1.3.0" as const;

/** Official Circle test USDC on Base Sepolia (verified on-chain: symbol USDC, decimals 6). */
export const USDC_BASE_SEPOLIA: Address = getAddress(
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
);

export const USDC_DECIMALS = 6;

export function chainFor(chainId: number): Chain {
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return baseSepolia;
  if (chainId === LOCAL_CHAIN_ID) return hardhat;
  throw new Error(`unsupported chain id: ${chainId}`);
}

/**
 * Public framework deployment addresses (DelegationManager, enforcers,
 * implementations). For the local Hardhat chain an environment must be
 * deployed at runtime with `deploySmartAccountsEnvironment` and passed in
 * explicitly, so this function refuses it.
 */
export function resolveSmartAccountsEnvironment(
  chainId: number,
): SmartAccountsEnvironment {
  if (chainId === LOCAL_CHAIN_ID) {
    throw new Error(
      "the local chain has no canonical deployment; deploy it with deploySmartAccountsEnvironment()",
    );
  }
  return getSmartAccountsEnvironment(chainId, FRAMEWORK_VERSION);
}

export const FAUCET_LINKS = [
  "https://docs.base.org/get-started/get-funds (Base Sepolia ETH)",
  "https://faucet.circle.com/ (Circle test USDC, select Base Sepolia)",
] as const;
