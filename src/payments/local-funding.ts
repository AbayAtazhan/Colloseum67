import { erc20Abi, parseAbi, parseEther, type Address } from "viem";
import type { BoundWalletClient, ReadClient } from "./clients";

const MINT_ABI = parseAbi(["function mint(address to, uint256 amount)"]);

/** Local testnet targets: at least 1 USDC (we top up to 5) and 1 ETH for prefunds. */
export const LOCAL_USDC_TARGET = 5_000_000n;
export const LOCAL_ETH_TARGET = parseEther("1");

export interface LocalFundingResult {
  usdcBalance: bigint;
  ethBalance: bigint;
  actions: string[];
}

/**
 * Local-mode only: gives the spending account test funds so the demo never
 * fails because of an empty wallet. On Base Sepolia this is replaced by the
 * faucet flow (`npm run network:prepare`).
 */
export async function ensureLocalSpendingFunds(params: {
  mode: "local" | "base-sepolia";
  publicClient: ReadClient;
  token: Address;
  deployerWallet: BoundWalletClient | null;
  smartAccountAddress: Address;
}): Promise<LocalFundingResult> {
  const balance = await params.publicClient.readContract({
    address: params.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [params.smartAccountAddress],
  });
  const ethBalance = await params.publicClient.getBalance({
    address: params.smartAccountAddress,
  });
  if (params.mode !== "local" || !params.deployerWallet) {
    return { usdcBalance: balance, ethBalance, actions: [] };
  }
  const actions: string[] = [];
  let usdcBalance = balance;
  let eth = ethBalance;

  if (usdcBalance < LOCAL_USDC_TARGET) {
    const delta = LOCAL_USDC_TARGET - usdcBalance;
    const hash = await params.deployerWallet.writeContract({
      address: params.token,
      abi: MINT_ABI,
      functionName: "mint",
      args: [params.smartAccountAddress, delta],
    });
    await params.publicClient.waitForTransactionReceipt({ hash });
    usdcBalance += delta;
    actions.push(`minted ${delta} test USDC to ${params.smartAccountAddress}`);
  }
  if (eth < LOCAL_ETH_TARGET) {
    const delta = LOCAL_ETH_TARGET - eth;
    const hash = await params.deployerWallet.sendTransaction({
      to: params.smartAccountAddress,
      value: delta,
    });
    await params.publicClient.waitForTransactionReceipt({ hash });
    eth += delta;
    actions.push(`funded ${delta} wei to ${params.smartAccountAddress}`);
  }
  return { usdcBalance, ethBalance: eth, actions };
}
