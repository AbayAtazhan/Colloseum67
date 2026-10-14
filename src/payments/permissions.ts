import {
  createDelegation,
  createExecution,
  ExecutionMode,
  ScopeType,
  type Caveat,
  type Caveats,
  type Delegation,
  type MetaMaskSmartAccount,
  type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import { DelegationManager } from "@metamask/smart-accounts-kit/contracts";
import {
  SIGNABLE_DELEGATION_TYPED_DATA,
  generateSalt,
  hashDelegation,
  toDelegationStruct,
} from "@metamask/smart-accounts-kit/utils";
import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import type { MissionPolicy } from "@/shared/types";
import { missionPolicyCaveat } from "./policy";

export const TRANSFER_SELECTOR = "0xa9059cbb" as const;

export function transferCalldata(recipient: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [getAddress(recipient), amount],
  });
}

export interface BuildRootDelegationParams {
  environment: SmartAccountsEnvironment;
  /** MetaMask smart account that owns the funds and signs the root. */
  from: Address;
  /** Server executor allowed to redelegate and redeem. */
  to: Address;
  policy: MissionPolicy;
  /**
   * Address of the deployed MissionPolicyEnforcer. When omitted the mission
   * still has the cumulative budget, timestamp and redeemer caveats, but no
   * recipient allow-list / per-call cap caveat.
   */
  enforcerAddress: Address | null;
  /** Deterministic salt (used when re-building a prepared delegation). */
  salt?: Hex;
}

/**
 * Builds the single root delegation of a mission. It is the only place where
 * mission-wide authority is created, and it must be signed by the user's
 * MetaMask smart account (the executor cannot mint a new root).
 */
export function buildRootDelegation(params: BuildRootDelegationParams): Delegation {
  const { environment, from, to, policy, enforcerAddress } = params;
  const caveats: (Caveat | { type: string } & Record<string, unknown>)[] = [
    {
      type: "timestamp",
      afterThreshold: policy.validAfter,
      beforeThreshold: policy.validBefore,
    },
    { type: "redeemer", redeemers: [getAddress(policy.redeemer)] },
  ];
  if (enforcerAddress) {
    caveats.push(missionPolicyCaveat(environment, enforcerAddress, policy));
  }

  return createDelegation({
    from: getAddress(from),
    to: getAddress(to),
    environment,
    // Random salt by default: two missions with identical policies must never
    // share a delegation hash. Re-builds pass the original salt explicitly.
    salt: params.salt ?? generateSalt(),
    scope: {
      type: ScopeType.Erc20TransferAmount,
      tokenAddress: policy.token.address,
      maxAmount: policy.budget,
    },
    caveats: caveats as Caveats,
  });
}

export async function signRootDelegation(
  userSmartAccount: MetaMaskSmartAccount,
  delegation: Delegation,
  chainId?: number,
): Promise<Delegation> {
  const signature = await userSmartAccount.signDelegation({
    delegation,
    ...(chainId ? { chainId } : {}),
  });
  return { ...delegation, signature };
}

export interface BuildChildDelegationParams {
  environment: SmartAccountsEnvironment;
  /** Executor smart account (or EOA) that currently holds the root delegation. */
  from: Address;
  /** Final redeemer. For the MVP this is the executor itself. */
  to: Address;
  parentDelegation: Delegation;
  policy: MissionPolicy;
  enforcerAddress: Address | null;
  recipient: Address;
  amount: bigint;
  /** Unix seconds after which this one-shot permission is invalid. */
  validUntil: number;
  /**
   * When true (default) the child also pins the exact call data, so the
   * permission can only ever transfer `amount` to `recipient`.
   */
  exactCalldata?: boolean;
  now?: number;
}

/**
 * Builds one child delegation per payment attempt. Each child:
 *  - is attenuated against the mission root (same root authority hash);
 *  - caps its own cumulative spend at the mission per-call cap;
 *  - can be spent exactly once (`limitedCalls: 1`);
 *  - expires;
 *  - only calls `transfer` on the mission token;
 *  - optionally pins the exact calldata (recipient + amount);
 *  - repeats the mission policy (recipient allow-list + per-call cap).
 *
 * The mission-wide cumulative budget lives on the root and is therefore not
 * reset by creating new children.
 */
export function buildOneShotChildDelegation(
  params: BuildChildDelegationParams,
): Delegation {
  const {
    environment,
    from,
    to,
    parentDelegation,
    policy,
    enforcerAddress,
    recipient,
    amount,
    validUntil,
    exactCalldata = true,
  } = params;
  const now = params.now ?? Math.floor(Date.now() / 1000);

  const caveats: (Caveat | { type: string } & Record<string, unknown>)[] = [
    { type: "timestamp", afterThreshold: now, beforeThreshold: validUntil },
    { type: "limitedCalls", limit: 1 },
    { type: "allowedTargets", targets: [policy.token.address] },
    { type: "allowedMethods", selectors: [TRANSFER_SELECTOR] },
  ];
  if (exactCalldata) {
    caveats.push({
      type: "exactCalldata",
      calldata: transferCalldata(recipient, amount),
    });
  }
  if (enforcerAddress) {
    caveats.push(missionPolicyCaveat(environment, enforcerAddress, policy));
  }

  return createDelegation({
    from: getAddress(from),
    to: getAddress(to),
    environment,
    parentDelegation,
    // Random salt: every one-shot payment permission gets a unique hash even
    // if the same agent requests the same amount in the same second.
    salt: generateSalt(),
    scope: {
      type: ScopeType.Erc20TransferAmount,
      tokenAddress: policy.token.address,
      maxAmount: policy.perCallMax,
    },
    caveats: caveats as Caveats,
  });
}

/**
 * Signs a delegation with a local EOA account (the executor). Mirrors the
 * SDK's signDelegation, but accepts an in-memory viem account.
 */
export async function signDelegationWithAccount(
  account: LocalAccount,
  delegation: Delegation,
  chainId: number,
  delegationManager: Address,
): Promise<Delegation> {
  const signature = await account.signTypedData({
    domain: {
      chainId,
      name: "DelegationManager",
      version: "1",
      verifyingContract: delegationManager,
    },
    types: SIGNABLE_DELEGATION_TYPED_DATA,
    primaryType: "Delegation",
    message: toDelegationStruct({ ...delegation, signature: "0x" }),
  });
  return { ...delegation, signature };
}

export function delegationHash(delegation: Delegation): Hex {
  return hashDelegation(delegation);
}

export interface EncodeRedeemParams {
  /** Leaf of the chain (one-shot payment permission). */
  child: Delegation;
  /** Mission root delegation. */
  root: Delegation;
  token: Address;
  recipient: Address;
  amount: bigint;
}

/** Encodes `DelegationManager.redeemDelegations` for the child→root chain. */
export function encodeRedeemPayment(params: EncodeRedeemParams): Hex {
  const execution = createExecution({
    target: params.token,
    callData: transferCalldata(params.recipient, params.amount),
  });
  return DelegationManager.encode.redeemDelegations({
    delegations: [[params.child, params.root]],
    modes: [ExecutionMode.SingleDefault],
    executions: [[execution]],
  });
}

/** Encodes the user-side revocation call (`DelegationManager.disableDelegation`). */
export function encodeDisableDelegation(delegation: Delegation): Hex {
  return DelegationManager.encode.disableDelegation({ delegation });
}
