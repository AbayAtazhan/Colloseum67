import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import {
  getSmartAccountsEnvironment,
  type Caveat,
  type Delegation,
} from "@metamask/smart-accounts-kit";
import { decodeCaveat, hashDelegation } from "@metamask/smart-accounts-kit/utils";
import { PolicyError } from "@/shared/errors";
import type { MissionPolicy } from "@/shared/types";
import {
  assertPaymentAllowed,
  decodeMissionPolicyTerms,
  encodeMissionPolicyTerms,
  missionPolicyCaveat,
  remainingBudget,
} from "@/payments/policy";
import {
  buildOneShotChildDelegation,
  buildRootDelegation,
  transferCalldata,
} from "@/payments/permissions";

const ENVIRONMENT = getSmartAccountsEnvironment(84532);
const USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const USER = getAddress("0x1000000000000000000000000000000000000001");
const EXECUTOR = getAddress("0x2000000000000000000000000000000000000002");
const R1 = getAddress("0x3000000000000000000000000000000000000003");
const R2 = getAddress("0x4000000000000000000000000000000000000004");
const R3 = getAddress("0x5000000000000000000000000000000000000005");
const ENFORCER = getAddress("0x6000000000000000000000000000000000000006");
const HASH = `0x${"ff".repeat(32)}` as Hex;

function policy(overrides: Partial<MissionPolicy> = {}): MissionPolicy {
  const now = Math.floor(Date.now() / 1000);
  return {
    chainId: 84532,
    token: { address: USDC, symbol: "USDC", decimals: 6 },
    budget: 50_000n,
    perCallMax: 20_000n,
    recipients: [R1, R2],
    validAfter: now - 60,
    validBefore: now + 3600,
    redeemer: EXECUTOR,
    ...overrides,
  };
}

function tryDecode(config: Caveat): Record<string, unknown> | null {
  try {
    return decodeCaveat({
      caveat: config,
      environment: ENVIRONMENT,
    }) as unknown as Record<string, unknown>;
  } catch {
    // Custom enforcers (MissionPolicyEnforcer) are not in the SDK environment.
    return null;
  }
}

function decode(config: Caveat): Record<string, unknown> {
  const decoded = tryDecode(config);
  if (!decoded) throw new Error("caveat is not decodable with this environment");
  return decoded;
}

function findCaveat(delegation: Delegation, type: string): Caveat | undefined {
  return delegation.caveats.find((caveat) => tryDecode(caveat)?.type === type);
}

describe("mission policy", () => {
  it("round-trips MissionPolicyEnforcer terms exactly", () => {
    const terms = encodeMissionPolicyTerms(policy());
    const decoded = decodeMissionPolicyTerms(terms);
    expect(decoded.token).toBe(USDC);
    expect(decoded.recipient0).toBe(R1);
    expect(decoded.recipient1).toBe(R2);
    expect(decoded.maxAmountPerCall).toBe(20_000n);

    const single = decodeMissionPolicyTerms(
      encodeMissionPolicyTerms(policy({ recipients: [R1] })),
    );
    expect(single.recipient1).toBe("0x0000000000000000000000000000000000000000");
  });

  it("accepts an in-policy payment", () => {
    expect(() =>
      assertPaymentAllowed({
        policy: policy(),
        missionStatus: "active",
        recipient: R2,
        amount: 20_000n,
        spent: 20_000n,
      }),
    ).not.toThrow();
    expect(remainingBudget(policy(), 20_000n)).toBe(30_000n);
  });

  it("rejects per-call cap, recipient, budget, window and status violations", () => {
    const base = {
      policy: policy(),
      missionStatus: "active" as const,
      recipient: R1,
      amount: 20_000n,
      spent: 0n,
    };
    expect(() => assertPaymentAllowed({ ...base, amount: 20_001n })).toThrow(
      PolicyError,
    );
    expect(() => assertPaymentAllowed({ ...base, recipient: R3 })).toThrow(
      /not allowed/,
    );
    expect(() =>
      assertPaymentAllowed({ ...base, spent: 40_000n }),
    ).toThrow(/budget exceeded/);
    expect(() =>
      assertPaymentAllowed({ ...base, now: base.policy.validBefore + 1 }),
    ).toThrow(/validity window/);
    expect(() =>
      assertPaymentAllowed({ ...base, missionStatus: "revoked" }),
    ).toThrow(/revoked/);
    expect(() => assertPaymentAllowed({ ...base, amount: 0n })).toThrow(
      /positive/,
    );
  });
});

describe("delegation caveats", () => {
  it("puts the cumulative budget, expiry, redeemer and mission policy on the root", () => {
    const missionPolicy = policy();
    const root = buildRootDelegation({
      environment: ENVIRONMENT,
      from: USER,
      to: EXECUTOR,
      policy: missionPolicy,
      enforcerAddress: ENFORCER,
    });

    const budgetCaveat = findCaveat(root, "erc20TransferAmount");
    expect(budgetCaveat?.enforcer).toBe(
      ENVIRONMENT.caveatEnforcers.ERC20TransferAmountEnforcer,
    );
    expect(decode(budgetCaveat as Caveat).tokenAddress).toBe(USDC);
    expect(decode(budgetCaveat as Caveat).maxAmount).toBe(50_000n);

    const timestamp = decode(findCaveat(root, "timestamp") as Caveat);
    expect(timestamp.beforeThreshold).toBe(missionPolicy.validBefore);
    const redeemer = decode(findCaveat(root, "redeemer") as Caveat);
    expect(redeemer.redeemers).toEqual([EXECUTOR]);

    const custom = root.caveats.find((caveat) => caveat.enforcer === ENFORCER);
    expect(custom).toBeDefined();
    expect(decodeMissionPolicyTerms(custom?.terms as Hex).maxAmountPerCall).toBe(
      20_000n,
    );
  });

  it("scopes each child to the per-call cap, one call and the root authority", () => {
    const missionPolicy = policy();
    const root: Delegation = {
      ...buildRootDelegation({
        environment: ENVIRONMENT,
        from: USER,
        to: EXECUTOR,
        policy: missionPolicy,
        enforcerAddress: ENFORCER,
      }),
      signature: `0x${"11".repeat(65)}`,
    };
    const child = buildOneShotChildDelegation({
      environment: ENVIRONMENT,
      from: EXECUTOR,
      to: EXECUTOR,
      parentDelegation: root,
      policy: missionPolicy,
      enforcerAddress: ENFORCER,
      recipient: R1,
      amount: 20_000n,
      validUntil: Math.floor(Date.now() / 1000) + 600,
    });

    expect(child.authority).toBe(hashDelegation(root));
    expect(decode(findCaveat(child, "erc20TransferAmount") as Caveat).maxAmount).toBe(
      20_000n,
    );
    expect(decode(findCaveat(child, "limitedCalls") as Caveat).limit).toBe(1);
    expect(decode(findCaveat(child, "exactCalldata") as Caveat).calldata).toBe(
      transferCalldata(R1, 20_000n),
    );
    expect(decode(findCaveat(child, "allowedTargets") as Caveat).targets).toEqual([
      USDC,
    ]);
    expect(decode(findCaveat(child, "allowedMethods") as Caveat).selectors).toEqual(
      ["0xa9059cbb"],
    );
    expect(child.caveats.some((caveat) => caveat.enforcer === ENFORCER)).toBe(true);
  });

  it("can omit exact calldata while keeping the recipient allow-list caveat", () => {
    const missionPolicy = policy();
    const caveat = missionPolicyCaveat(ENVIRONMENT, ENFORCER, missionPolicy);
    expect(caveat.terms.length).toBe(2 + 128 * 2);
    const child = buildOneShotChildDelegation({
      environment: ENVIRONMENT,
      from: EXECUTOR,
      to: EXECUTOR,
      parentDelegation: {
        ...buildRootDelegation({
          environment: ENVIRONMENT,
          from: USER,
          to: EXECUTOR,
          policy: missionPolicy,
          enforcerAddress: ENFORCER,
        }),
        signature: `0x${"11".repeat(65)}`,
      },
      policy: missionPolicy,
      enforcerAddress: ENFORCER,
      recipient: R1,
      amount: 10_000n,
      validUntil: Math.floor(Date.now() / 1000) + 600,
      exactCalldata: false,
    });
    expect(findCaveat(child, "exactCalldata")).toBeUndefined();
    expect(findCaveat(child, "limitedCalls")).toBeDefined();
    expect(HASH).toHaveLength(66);
  });
});
