import {
  Implementation,
  toMetaMaskSmartAccount,
  type MetaMaskSmartAccount,
  type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { entryPoint07Abi, toPackedUserOperation } from "viem/account-abstraction";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { InfrastructureError } from "@/shared/errors";
import type { BoundWalletClient, ReadClient } from "./clients";

/** In-memory EOA account from a hex private key. Never log the key itself. */
export function accountFromPrivateKey(privateKey: Hex): LocalAccount {
  return privateKeyToAccount(privateKey);
}

export interface CreateUserSmartAccountParams {
  publicClient: ReadClient;
  owner: LocalAccount;
  environment: SmartAccountsEnvironment;
  /** Optional custom salt for counterfactual deployments. */
  deploySalt?: Hex;
}

/**
 * Creates the user's MetaMask Hybrid smart account. The same `deployParams`
 * always derive the same counterfactual address, so this can run before the
 * account is deployed.
 */
export async function createUserSmartAccount(
  params: CreateUserSmartAccountParams,
): Promise<MetaMaskSmartAccount> {
  return toMetaMaskSmartAccount({
    client: params.publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [params.owner.address, [], [], []],
    deploySalt: params.deploySalt ?? "0x",
    signer: { account: params.owner },
    environment: params.environment,
  });
}

/**
 * Deploys a counterfactual MetaMask smart account by calling its factory.
 * Any funded account may pay for this; the owner key is not required here.
 */
export async function deploySmartAccount(params: {
  publicClient: ReadClient;
  walletClient: BoundWalletClient;
  smartAccount: MetaMaskSmartAccount;
}): Promise<Address> {
  const { publicClient, walletClient, smartAccount } = params;
  const code = await publicClient.getCode({ address: smartAccount.address });
  if (code && code !== "0x") return smartAccount.address;

  const factoryArgs = await smartAccount.getFactoryArgs();
  if (!factoryArgs.factory || !factoryArgs.factoryData) {
    throw new InfrastructureError("smart account factory args are unavailable");
  }
  const hash = await walletClient.sendTransaction({
    to: factoryArgs.factory,
    data: factoryArgs.factoryData,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new InfrastructureError("smart account deployment transaction reverted");
  }
  return smartAccount.address;
}

export interface SmartAccountCallParams {
  publicClient: ReadClient;
  /** Funded account that pays for the user operation. */
  walletClient: BoundWalletClient;
  smartAccount: MetaMaskSmartAccount;
  entryPoint: Address;
  beneficiary: Address;
  to: Address;
  data: Hex;
  value?: bigint;
}

/**
 * Sends a call from a MetaMask smart account without a bundler: it builds the
 * v0.7 user operation, signs it with the account, and submits
 * `EntryPoint.handleOps` directly. Only used for owner-side operations such as
 * revocation; payments go through the delegation manager.
 */
export async function sendSmartAccountCall(
  params: SmartAccountCallParams,
): Promise<Hex> {
  const { publicClient, walletClient, smartAccount } = params;
  const callData = await smartAccount.encodeCalls([
    { to: params.to, data: params.data, value: params.value ?? 0n },
  ]);
  const nonce = await smartAccount.getNonce();
  const fees = await publicClient.estimateFeesPerGas();
  const gasPrice = await publicClient.getGasPrice();
  const maxFeePerGas = fees.maxFeePerGas ?? gasPrice;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? gasPrice;

  const userOperation = {
    sender: smartAccount.address,
    nonce,
    callData,
    callGasLimit: 2_000_000n,
    verificationGasLimit: 2_000_000n,
    preVerificationGas: 300_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
    signature: "0x" as Hex,
  };
  const signature = await smartAccount.signUserOperation(userOperation);
  const packed = toPackedUserOperation({ ...userOperation, signature });

  const hash = await walletClient.sendTransaction({
    to: params.entryPoint,
    data: encodeFunctionData({
      abi: entryPoint07Abi,
      functionName: "handleOps",
      args: [[packed], params.beneficiary],
    }),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new InfrastructureError("smart account user operation reverted");
  }
  return hash;
}
