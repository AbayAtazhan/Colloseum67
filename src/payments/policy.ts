import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import type { Caveat, SmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { PolicyError } from "@/shared/errors";
import type { MissionPolicy, MissionStatus } from "@/shared/types";

/**
 * Terms layout for MissionPolicyEnforcer:
 *   abi.encode(address token, address recipient0, address recipient1, uint256 maxAmountPerCall)
 *
 * Stored as 128 bytes. recipient1 may be the zero address when the mission has
 * a single allowed recipient.
 */
const MISSION_POLICY_TERMS = [
  { type: "address", name: "token" },
  { type: "address", name: "recipient0" },
  { type: "address", name: "recipient1" },
  { type: "uint256", name: "maxAmountPerCall" },
] as const;

export interface MissionPolicyTerms {
  token: Address;
  recipient0: Address;
  recipient1: Address;
  maxAmountPerCall: bigint;
}

export function encodeMissionPolicyTerms(
  policy: Pick<MissionPolicy, "token" | "recipients" | "perCallMax">,
): Hex {
  if (policy.recipients.length < 1 || policy.recipients.length > 2) {
    throw new PolicyError("mission policy needs one or two allowed recipients");
  }
  const [recipient0, recipient1 = "0x0000000000000000000000000000000000000000"] =
    policy.recipients;
  return encodeAbiParameters(MISSION_POLICY_TERMS, [
    policy.token.address,
    getAddress(recipient0),
    getAddress(recipient1),
    policy.perCallMax,
  ]);
}

export function decodeMissionPolicyTerms(terms: Hex): MissionPolicyTerms {
  const [token, recipient0, recipient1, maxAmountPerCall] = decodeAbiParameters(
    MISSION_POLICY_TERMS,
    terms,
  );
  return {
    token: getAddress(token),
    recipient0: getAddress(recipient0),
    recipient1: getAddress(recipient1),
    maxAmountPerCall,
  };
}

export function missionPolicyCaveat(
  _environment: SmartAccountsEnvironment,
  enforcerAddress: Address,
  policy: Pick<MissionPolicy, "token" | "recipients" | "perCallMax">,
): Caveat {
  return {
    enforcer: enforcerAddress,
    terms: encodeMissionPolicyTerms(policy),
    args: "0x",
  };
}

export interface PaymentPolicyCheck {
  policy: MissionPolicy;
  missionStatus: MissionStatus;
  recipient: Address;
  amount: bigint;
  /** Spend already recorded locally (settled receipts). */
  spent: bigint;
  now?: number;
}

/**
 * Server-side pre-flight. This is a UX guard only: the same restrictions are
 * enforced by caveats on-chain, so bypassing this check cannot exceed them.
 */
export function assertPaymentAllowed(check: PaymentPolicyCheck): void {
  const { policy, recipient, amount, spent } = check;
  const now = check.now ?? Math.floor(Date.now() / 1000);

  if (check.missionStatus !== "active") {
    throw new PolicyError(`mission is ${check.missionStatus}`);
  }
  if (amount <= 0n) {
    throw new PolicyError("payment amount must be positive");
  }
  if (amount > policy.perCallMax) {
    throw new PolicyError(
      `amount ${amount} exceeds per-call cap ${policy.perCallMax}`,
    );
  }
  const allowed = policy.recipients.map((value) => getAddress(value));
  if (!allowed.includes(getAddress(recipient))) {
    throw new PolicyError(`recipient ${recipient} is not allowed by the mission`);
  }
  if (now < policy.validAfter || now >= policy.validBefore) {
    throw new PolicyError(
      `mission validity window is [${policy.validAfter}, ${policy.validBefore}), now=${now}`,
    );
  }
  if (spent + amount > policy.budget) {
    throw new PolicyError(
      `mission budget exceeded: spent=${spent} + amount=${amount} > budget=${policy.budget}`,
    );
  }
}

/** Remaining budget according to locally recorded receipts. */
export function remainingBudget(
  policy: MissionPolicy,
  spent: bigint,
): bigint {
  return policy.budget > spent ? policy.budget - spent : 0n;
}
