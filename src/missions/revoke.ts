import {
  Implementation,
  toMetaMaskSmartAccount,
  type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import { HybridDeleGator } from "@metamask/delegation-abis";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import type { Store } from "@/store";
import { PolicyError, SetupRequiredError } from "@/shared/errors";
import type { MissionRecord } from "@/shared/types";
import type { BoundWalletClient, ReadClient } from "@/payments/clients";
import {
  prepareUserOperation,
  submitUserOperation,
  verifyUserOperationSignature,
  type PreparedUserOperation,
} from "@/payments/userop";

export interface RevocationContext {
  store: Store;
  publicClient: ReadClient;
  walletClient: BoundWalletClient;
  beneficiary: Address;
  entryPoint: Address;
  chainId: number;
  environment: SmartAccountsEnvironment;
}

export interface PreparedMissionRevocation {
  missionId: string;
  ownerAddress: Address;
  smartAccountAddress: Address;
  userOp: PreparedUserOperation;
  delegationHash: Hex;
}

async function deriveSmartAccount(
  context: RevocationContext,
  ownerAddress: Address,
) {
  return toMetaMaskSmartAccount({
    client: context.publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [getAddress(ownerAddress), [], [], []],
    deploySalt: "0x",
    environment: context.environment,
  });
}

export function revokeCallData(mission: MissionRecord): Hex {
  return encodeFunctionData({
    abi: HybridDeleGator,
    functionName: "disableDelegation",
    args: [
      {
        ...mission.rootDelegation,
        salt: BigInt(mission.rootDelegation.salt),
      },
    ],
  });
}

/**
 * Builds the owner-signed user operation that disables the mission root on the
 * DelegationManager. The owner key stays in the browser: this function only
 * prepares the typed data for `eth_signTypedData_v4`.
 */
export async function prepareMissionRevocation(
  context: RevocationContext,
  missionId: string,
): Promise<PreparedMissionRevocation> {
  const mission = context.store.getMission(missionId);
  if (mission.status === "revoked") {
    throw new PolicyError("mission permission is already revoked");
  }
  const smartAccount = await deriveSmartAccount(context, mission.ownerAddress);
  if (
    getAddress(smartAccount.address) !== getAddress(mission.smartAccountAddress)
  ) {
    throw new SetupRequiredError(
      "the mission owner does not control the recorded smart account",
    );
  }
  const userOp = await prepareUserOperation({
    publicClient: context.publicClient,
    smartAccount,
    entryPoint: context.entryPoint,
    chainId: context.chainId,
    call: { to: smartAccount.address, data: revokeCallData(mission) },
  });
  return {
    missionId: mission.id,
    ownerAddress: mission.ownerAddress,
    smartAccountAddress: smartAccount.address,
    userOp,
    delegationHash: mission.rootDelegationHash,
  };
}

/**
 * Validates that the submitted user operation is exactly the revocation call
 * for this mission, checks the owner signature over the packed operation, then
 * submits it through EntryPoint (gas paid by the relayer/deployer).
 */
export async function submitMissionRevocation(
  context: RevocationContext,
  params: {
    missionId: string;
    userOp: Omit<PreparedUserOperation, "typedData">;
    signature: Hex;
  },
): Promise<Hex> {
  const mission = context.store.getMission(params.missionId);
  const operator = params.userOp;
  if (getAddress(operator.sender) !== getAddress(mission.smartAccountAddress)) {
    throw new PolicyError("user operation sender is not the mission smart account");
  }
  const expectedCallData = revokeCallData(mission).toLowerCase();
  if (operator.callData.toLowerCase() !== expectedCallData) {
    throw new PolicyError(
      "user operation does not disable this mission's root permission",
    );
  }
  if (getAddress(operator.entryPoint) !== getAddress(context.entryPoint)) {
    throw new PolicyError("unexpected EntryPoint in the revocation user operation");
  }
  const signatureValid = await verifyUserOperationSignature({
    owner: mission.ownerAddress,
    operation: operator,
    signature: params.signature,
    chainId: context.chainId,
  });
  if (!signatureValid) {
    throw new PolicyError("owner signature over the revocation is invalid");
  }
  const txHash = await submitUserOperation({
    publicClient: context.publicClient,
    walletClient: context.walletClient,
    operation: operator,
    signature: params.signature,
    beneficiary: context.beneficiary,
  });
  context.store.appendEvent({
    missionId: mission.id,
    type: "mission.revoke.confirmed",
    payload: { txHash, ownerAddress: mission.ownerAddress },
  });
  context.store.updateMissionStatus(mission.id, "revoked");
  return txHash;
}

/** Signs a prepared revocation with a local account (tests and server fallback). */
export async function signRevocationWithAccount(
  account: LocalAccount,
  prepared: PreparedMissionRevocation,
): Promise<Hex> {
  return account.signTypedData({
    domain: prepared.userOp.typedData.domain,
    types: prepared.userOp.typedData.types,
    primaryType: "PackedUserOperation",
    message: prepared.userOp.typedData.message,
  } as never);
}
