import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createDelegation,
  getSmartAccountsEnvironment,
  ScopeType,
  type Delegation,
} from "@metamask/smart-accounts-kit";
import {
  decodeCaveat,
  decodeDelegations,
  generateSalt,
  hashDelegation,
} from "@metamask/smart-accounts-kit/utils";
import { createx402DelegationProvider } from "@metamask/smart-accounts-kit/experimental";
import type { PaymentRequirements } from "@x402/core/types";
import { ValidationError } from "@/shared/errors";
import {
  assertAcceptedMatches,
  buildPaymentRequirements,
  fromCaip2,
  toCaip2,
} from "@/x402/requirements";
import { createProviderDefinitions } from "@/providers/data";
import {
  canonicalRequestJson,
  requestHash,
} from "@/providers/types";
import { buildRootDelegation } from "@/payments/permissions";
import type { MissionPolicy } from "@/shared/types";

const ENVIRONMENT = getSmartAccountsEnvironment(84532);
const USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const USER = getAddress("0x1000000000000000000000000000000000000001");
const EXECUTOR = getAddress("0x2000000000000000000000000000000000000002");
const RELAYER = getAddress("0x2000000000000000000000000000000000000009");
const R1 = getAddress("0x3000000000000000000000000000000000000003");
const R2 = getAddress("0x4000000000000000000000000000000000000004");
const ENFORCER = getAddress("0x6000000000000000000000000000000000000006");

function policy(): MissionPolicy {
  const now = Math.floor(Date.now() / 1000);
  return {
    chainId: 84532,
    token: { address: USDC, symbol: "USDC", decimals: 6 },
    budget: 50_000n,
    perCallMax: 20_000n,
    recipients: [R1, R2],
    validAfter: now - 60,
    validBefore: now + 3600,
    redeemer: RELAYER,
  };
}

function signedRoot(): Delegation {
  const root = buildRootDelegation({
    environment: ENVIRONMENT,
    from: USER,
    to: EXECUTOR,
    policy: policy(),
    enforcerAddress: ENFORCER,
  });
  return { ...root, signature: `0x${"11".repeat(65)}` };
}

function requirements(): PaymentRequirements {
  const providers = createProviderDefinitions({
    codePayTo: R1,
    activityPayTo: R2,
    chainId: 84532,
  });
  return buildPaymentRequirements(providers.code, {
    chainId: 84532,
    network: toCaip2(84532),
    token: { address: USDC, symbol: "USDC", decimals: 6 },
    relayerAddress: RELAYER,
    maxTimeoutSeconds: 120,
    resourceBaseUrl: "http://localhost:3000",
  });
}

describe("x402 requirements", () => {
  it("advertises exact ERC-7710 with the relayer as facilitator", () => {
    const req = requirements();
    expect(req.scheme).toBe("exact");
    expect(req.network).toBe("eip155:84532");
    expect(req.amount).toBe("20000");
    expect(req.asset).toBe(USDC);
    expect(req.payTo).toBe(R1);
    expect(req.extra?.assetTransferMethod).toBe("erc7710");
    expect(req.extra?.paymentFlow).toBe("upfront");
    expect(req.extra?.facilitatorAddresses).toEqual([RELAYER]);
    expect(fromCaip2(String(req.network))).toBe(84532);
  });

  it("rejects tampered accepted terms", () => {
    const req = requirements();
    expect(() =>
      assertAcceptedMatches({ ...req, amount: "10000" }, req),
    ).toThrow(ValidationError);
    expect(() =>
      assertAcceptedMatches({ ...req, payTo: R2 }, req),
    ).toThrow(/recipient/i);
    expect(() =>
      assertAcceptedMatches({ ...req, network: "eip155:1" }, req),
    ).toThrow(/network/i);
    expect(() =>
      assertAcceptedMatches({ ...req, asset: EXECUTOR }, req),
    ).toThrow(/asset/i);
  });

  it("hashes requests deterministically and binds provider + args", () => {
    const a = canonicalRequestJson("code", { address: R1 });
    const b = canonicalRequestJson("code", { address: getAddress(R1) });
    expect(a).toBe(b);
    expect(requestHash("code", { address: R1 })).toBe(
      requestHash("code", { address: R1 }),
    );
    expect(requestHash("code", { address: R1 })).not.toBe(
      requestHash("activity", { address: R1 }),
    );
    expect(requestHash("code", { address: R1 })).not.toBe(
      requestHash("code", { address: R2 }),
    );
  });
});

describe("official MetaMask x402 delegation provider under a shared root", () => {
  it("creates a child of the mission root, not a new root budget", async () => {
    const root = signedRoot();
    const req = requirements();
    const provider = createx402DelegationProvider({
      account: privateKeyToAccount(
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      ),
      environment: ENVIRONMENT,
      from: EXECUTOR,
      parentPermissionContext: [root],
      salt: generateSalt(),
      expirySeconds: 300,
      redeemers: { requireRedeemers: true, addresses: [RELAYER] },
    });
    const payload = await provider(req);
    expect(getAddress(payload.delegator)).toBe(USER);

    const chain = decodeDelegations(payload.permissionContext as Hex);
    expect(chain).toHaveLength(2);
    const [child, parent] = chain;
    expect(hashDelegation(parent)).toBe(hashDelegation(root));
    expect(child.authority).toBe(hashDelegation(root));
    expect(child.delegator).toBe(EXECUTOR);
    expect(child.delegate.toLowerCase()).toBe("0x0000000000000000000000000000000000000a11");

    // The child pins the payee; the redeemer restriction is inherited from the
    // root (the helper skips a duplicate caveat that the parent already has).
    const decodeAll = (caveats: typeof child.caveats) =>
      caveats.map((caveat) => {
        try {
          return decodeCaveat({ caveat, environment: ENVIRONMENT }) as Record<
            string,
            unknown
          >;
        } catch {
          return null;
        }
      });
    const childDecoded = decodeAll(child.caveats);
    const allowedCalldata = childDecoded.find(
      (item) => item?.type === "allowedCalldata",
    );
    expect(allowedCalldata).toBeDefined();
    expect(String(allowedCalldata?.value).endsWith(R1.slice(2).toLowerCase())).toBe(
      true,
    );
    const redeemer = [
      ...childDecoded,
      ...decodeAll(parent.caveats),
    ].find((item) => item?.type === "redeemer");
    expect(redeemer?.redeemers).toEqual([RELAYER]);
    const amountCaveat = childDecoded.find(
      (item) => item?.type === "erc20TransferAmount",
    );
    expect(amountCaveat?.maxAmount).toBe(20_000n);
  });
});

describe("scope smoke", () => {
  it("createDelegation quick sanity for the environment used above", () => {
    const delegation = createDelegation({
      from: USER,
      to: EXECUTOR,
      environment: ENVIRONMENT,
      scope: {
        type: ScopeType.Erc20TransferAmount,
        tokenAddress: USDC,
        maxAmount: 1n,
      },
    });
    expect(delegation.caveats.length).toBeGreaterThan(0);
  });
});

describe("provider definitions", () => {
  it("fixes the price and payee per provider", () => {
    const providers = createProviderDefinitions({
      codePayTo: R1,
      activityPayTo: R2,
      chainId: 84532,
    });
    expect(providers.code.payTo).toBe(R1);
    expect(providers.activity.payTo).toBe(R2);
    expect(providers.code.price).toBe(20_000n);
    expect(providers.activity.price).toBe(20_000n);
    expect(() => providers.code.parseArgs(new URLSearchParams("address=0x1"))).toThrow();
    expect(
      providers.activity.parseArgs(
        new URLSearchParams(`address=${R1}&blockNumber=123`),
      ),
    ).toEqual({ address: R1, blockNumber: 123 });
  });
});
