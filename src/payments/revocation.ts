import type { Address, Hex } from "viem";
import type { MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import type { Store } from "@/store";
import { sendSmartAccountCall } from "./accounts";
import type { BoundWalletClient, ReadClient } from "./clients";
import { encodeDisableDelegation } from "./permissions";

export interface RevokeMissionRootParams {
  store: Store;
  publicClient: ReadClient;
  /** Funded account that pays for the user operation. */
  walletClient: BoundWalletClient;
  smartAccount: MetaMaskSmartAccount;
  entryPoint: Address;
  beneficiary: Address;
  delegationManager: Address;
  missionId: string;
}

/**
 * Revokes a mission by disabling the root delegation on the DelegationManager.
 * The call must come from the delegator (the user's smart account), so it is
 * sent as a user operation signed by the owner.
 */
export async function revokeMissionRoot(
  params: RevokeMissionRootParams,
): Promise<Hex> {
  const mission = params.store.getMission(params.missionId);
  const data = encodeDisableDelegation(mission.rootDelegation);
  const txHash = await sendSmartAccountCall({
    publicClient: params.publicClient,
    walletClient: params.walletClient,
    smartAccount: params.smartAccount,
    entryPoint: params.entryPoint,
    beneficiary: params.beneficiary,
    to: params.delegationManager,
    data,
  });
  params.store.updateMissionStatus(mission.id, "revoked");
  return txHash;
}
