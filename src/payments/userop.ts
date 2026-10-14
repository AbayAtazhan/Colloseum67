import { entryPoint07Abi, toPackedUserOperation } from "viem/account-abstraction";
import { encodeFunctionData, getAddress, parseEventLogs, type Address, type Hex } from "viem";
import { SIGNABLE_USER_OP_TYPED_DATA } from "@metamask/smart-accounts-kit/utils";
import type { MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { verifyTypedData } from "viem";
import { InfrastructureError } from "@/shared/errors";
import type { BoundWalletClient, ReadClient } from "./clients";
import { withEip712Domain, type WalletTypedDataTypes } from "./typed-data";

/**
 * Browser-wallet user operation support.
 *
 * The MetaMask smart account signs a typed `PackedUserOperation` exactly as the
 * SDK's `signUserOperation` does; the server never needs the owner key and only
 * submits the already-signed operation through EntryPoint (gas paid by a
 * testnet relayer/deployer).
 */
export interface SerializedUserOperation {
  sender: Address;
  nonce: string;
  callData: Hex;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  entryPoint: Address;
}

export interface UserOperationTypedData {
  domain: {
    chainId: number;
    name: string;
    version: string;
    verifyingContract: Address;
  };
  types: WalletTypedDataTypes;
  primaryType: "PackedUserOperation";
  message: Record<string, unknown>;
}

export interface PreparedUserOperation extends SerializedUserOperation {
  typedData: UserOperationTypedData;
}

const GAS_DEFAULTS = {
  callGasLimit: 2_000_000n,
  verificationGasLimit: 2_000_000n,
  preVerificationGas: 300_000n,
};

export async function prepareUserOperation(params: {
  publicClient: ReadClient;
  smartAccount: MetaMaskSmartAccount;
  entryPoint: Address;
  chainId: number;
  call: { to: Address; data: Hex; value?: bigint };
  /** EIP-712 domain name of the delegator implementation. */
  name?: string;
}): Promise<PreparedUserOperation> {
  const callData = await params.smartAccount.encodeCalls([
    {
      to: params.call.to,
      data: params.call.data,
      value: params.call.value ?? 0n,
    },
  ]);
  const nonce = await params.smartAccount.getNonce();
  const fees = await params.publicClient.estimateFeesPerGas();
  const gasPrice = await params.publicClient.getGasPrice();
  const serialized: SerializedUserOperation = {
    sender: params.smartAccount.address,
    nonce: nonce.toString(),
    callData,
    callGasLimit: GAS_DEFAULTS.callGasLimit.toString(),
    verificationGasLimit: GAS_DEFAULTS.verificationGasLimit.toString(),
    preVerificationGas: GAS_DEFAULTS.preVerificationGas.toString(),
    maxFeePerGas: (fees.maxFeePerGas ?? gasPrice).toString(),
    maxPriorityFeePerGas: (fees.maxPriorityFeePerGas ?? gasPrice).toString(),
    entryPoint: params.entryPoint,
  };
  return {
    ...serialized,
    typedData: buildUserOperationTypedData(serialized, {
      chainId: params.chainId,
      name: params.name ?? "HybridDeleGator",
    }),
  };
}

export function buildUserOperationTypedData(
  operation: SerializedUserOperation,
  meta: { chainId: number; name?: string },
): UserOperationTypedData {
  const packed = toPackedUserOperation({
    sender: operation.sender,
    nonce: BigInt(operation.nonce),
    callData: operation.callData,
    callGasLimit: BigInt(operation.callGasLimit),
    verificationGasLimit: BigInt(operation.verificationGasLimit),
    preVerificationGas: BigInt(operation.preVerificationGas),
    maxFeePerGas: BigInt(operation.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(operation.maxPriorityFeePerGas),
    signature: "0x",
  });
  return {
    domain: {
      chainId: meta.chainId,
      name: meta.name ?? "HybridDeleGator",
      version: "1",
      verifyingContract: operation.sender,
    },
    types: withEip712Domain(SIGNABLE_USER_OP_TYPED_DATA),
    primaryType: "PackedUserOperation",
    message: {
      ...packed,
      nonce: packed.nonce.toString(),
      preVerificationGas: packed.preVerificationGas.toString(),
      entryPoint: operation.entryPoint,
    },
  };
}

export async function verifyUserOperationSignature(params: {
  owner: Address;
  operation: SerializedUserOperation;
  signature: Hex;
  chainId: number;
}): Promise<boolean> {
  const typedData = buildUserOperationTypedData(params.operation, {
    chainId: params.chainId,
  });
  return verifyTypedData({
    address: params.owner,
    domain: typedData.domain,
    types: SIGNABLE_USER_OP_TYPED_DATA,
    primaryType: "PackedUserOperation",
    message: typedData.message,
    signature: params.signature,
  });
}

export async function submitUserOperation(params: {
  publicClient: ReadClient;
  walletClient: BoundWalletClient;
  operation: SerializedUserOperation;
  signature: Hex;
  beneficiary: Address;
}): Promise<Hex> {
  const packed = toPackedUserOperation({
    sender: params.operation.sender,
    nonce: BigInt(params.operation.nonce),
    callData: params.operation.callData,
    callGasLimit: BigInt(params.operation.callGasLimit),
    verificationGasLimit: BigInt(params.operation.verificationGasLimit),
    preVerificationGas: BigInt(params.operation.preVerificationGas),
    maxFeePerGas: BigInt(params.operation.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(params.operation.maxPriorityFeePerGas),
    signature: params.signature,
  });
  const hash = await params.walletClient.sendTransaction({
    to: params.operation.entryPoint,
    data: encodeFunctionData({
      abi: entryPoint07Abi,
      functionName: "handleOps",
      args: [[packed], params.beneficiary],
    }),
  });
  const receipt = await params.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new InfrastructureError(
      `user operation transaction ${hash} reverted`,
    );
  }
  // handleOps can succeed as a transaction while the inner account call fails.
  const outcome = parseEventLogs({
    abi: entryPoint07Abi,
    logs: receipt.logs,
    eventName: "UserOperationEvent",
  }).find((event) =>
    getAddress(event.address) === getAddress(params.operation.entryPoint) &&
    getAddress(event.args.sender) === getAddress(params.operation.sender) &&
    event.args.nonce === BigInt(params.operation.nonce),
  );
  if (!outcome?.args.success) {
    throw new InfrastructureError(`user operation in ${hash} failed inside EntryPoint`);
  }
  return hash;
}
