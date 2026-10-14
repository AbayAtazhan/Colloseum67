import {
  Implementation,
  ROOT_AUTHORITY,
  toMetaMaskSmartAccount,
  type Delegation,
  type MetaMaskSmartAccount,
} from "@metamask/smart-accounts-kit";
import {
  SIGNABLE_DELEGATION_TYPED_DATA,
  decodeCaveat,
  toDelegationStruct,
} from "@metamask/smart-accounts-kit/utils";
import { getAddress, verifyTypedData, type Address, type Hex } from "viem";
import type { Store } from "@/store";
import { parseAmount } from "@/shared/amounts";
import { PolicyError, SetupRequiredError, ValidationError } from "@/shared/errors";
import type { MissionPolicy, MissionRecord } from "@/shared/types";
import { createUserSmartAccount, deploySmartAccount, sendSmartAccountCall } from "@/payments/accounts";
import {
  buildRootDelegation,
  delegationHash,
  encodeDisableDelegation,
  signRootDelegation,
} from "@/payments/permissions";
import { decodeMissionPolicyTerms } from "@/payments/policy";
import { ensureLocalSpendingFunds } from "@/payments/local-funding";
import { withEip712Domain, type WalletTypedDataTypes } from "@/payments/typed-data";
import type { AppRuntime } from "@/payments/runtime";
import type { MissionScenario } from "@/shared/exit-check";

export interface MissionDraftInput {
  title: string;
  task: string;
  addresses: Address[];
  /** Decimal USDC string, e.g. "0.05". */
  budgetUsdc?: string;
  scenario?: MissionScenario;
  positionUsd?: string;
}

export interface PreparedWalletMission {
  ownerAddress: Address;
  smartAccountAddress: Address;
  delegation: Delegation;
  typedData: {
    domain: {
      chainId: number;
      name: string;
      version: string;
      verifyingContract: Address;
    };
    types: WalletTypedDataTypes;
    primaryType: "Delegation";
    message: Record<string, unknown>;
  };
}

function validateInput(runtime: AppRuntime, input: MissionDraftInput): Address[] {
  if (!runtime.config.enforcerAddress) {
    throw new SetupRequiredError("deploy and configure MissionPolicyEnforcer before creating a mission");
  }
  if (!input.title.trim()) throw new ValidationError("title is required");
  if (!input.task.trim()) throw new ValidationError("task is required");
  const addresses = input.addresses.map((address) => {
    try {
      return getAddress(address);
    } catch {
      throw new ValidationError(`invalid address: ${address}`);
    }
  });
  if (addresses.length < 1 || addresses.length > 2) {
    throw new ValidationError("provide one or two addresses");
  }
  if (input.scenario === "exit-check") {
    if (new Set(addresses).size !== addresses.length) throw new ValidationError("choose different token addresses");
    if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(input.positionUsd ?? "100") ||
      Number(input.positionUsd ?? "100") < 1 || Number(input.positionUsd ?? "100") > 100_000) {
      throw new ValidationError("position must be between $1 and $100,000");
    }
  }
  if (!runtime.config.relayerAddress) {
    throw new SetupRequiredError(
      "the relayer/facilitator account is not configured; set RELAYER_PRIVATE_KEY or EXECUTOR_PRIVATE_KEY",
    );
  }
  return addresses;
}

/**
 * The validity window is anchored to the chain's latest block timestamp (not
 * the server wall clock) so `TimestampEnforcer` cannot reject a fresh mission
 * as "early" on a local node whose blocks lag real time. The window starts
 * immediately (0) and ends after the configured duration.
 */
async function buildPolicy(
  runtime: AppRuntime,
  budgetUsdc?: string,
): Promise<MissionPolicy> {
  const relayerAddress = runtime.config.relayerAddress;
  if (!relayerAddress) {
    throw new SetupRequiredError(
      "the relayer/facilitator account is not configured; set RELAYER_PRIVATE_KEY or EXECUTOR_PRIVATE_KEY",
    );
  }
  const budget = budgetUsdc
    ? parseAmount(budgetUsdc, runtime.config.token.decimals)
    : runtime.config.budget;
  if (budget <= 0n) throw new ValidationError("budget must be positive");
  if (budget > 1_000_000n) {
    throw new ValidationError("budget is unreasonably large for a demo mission");
  }
  const perCallMax =
    budget < runtime.config.perCallMax ? budget : runtime.config.perCallMax;
  const latestBlock = await runtime.publicClient.getBlock();
  const blockTime = Number(latestBlock.timestamp);
  return {
    chainId: runtime.config.chainId,
    token: runtime.config.token,
    budget,
    perCallMax,
    recipients: runtime.config.recipients,
    validAfter: 0,
    validBefore: blockTime + runtime.config.validitySeconds,
    redeemer: relayerAddress,
  };
}

/** Creates a mission signed by the server-side local test owner (test mode). */
export async function createLocalMission(params: {
  runtime: AppRuntime;
  store: Store;
  input: MissionDraftInput;
}): Promise<MissionRecord> {
  const { runtime, store } = params;
  const addresses = validateInput(runtime, params.input);
  if (!runtime.owner || !runtime.config.executorAddress) {
    throw new SetupRequiredError("local owner/executor accounts are unavailable");
  }
  const policy = await buildPolicy(runtime, params.input.budgetUsdc);
  const smartAccount = await createUserSmartAccount({
    publicClient: runtime.publicClient,
    owner: runtime.owner,
    environment: runtime.environment,
  });
  const unsignedRoot = buildRootDelegation({
    environment: runtime.environment,
    from: smartAccount.address,
    to: runtime.config.executorAddress,
    policy,
    enforcerAddress: runtime.config.enforcerAddress,
  });
  const rootDelegation = await signRootDelegation(
    smartAccount,
    unsignedRoot,
    runtime.config.chainId,
  );
  return store.createMission({
    title: params.input.title,
    context: { task: params.input.task, addresses, scenario: params.input.scenario ?? "research", positionUsd: params.input.positionUsd ?? "100" },
    policy,
    ownerAddress: runtime.owner.address,
    smartAccountAddress: smartAccount.address,
    executorAddress: runtime.config.executorAddress,
    rootDelegation,
    rootDelegationHash: delegationHash(rootDelegation),
    enforcerAddress: runtime.config.enforcerAddress,
  });
}

async function deriveSmartAccount(
  runtime: AppRuntime,
  ownerAddress: Address,
): Promise<MetaMaskSmartAccount> {
  return toMetaMaskSmartAccount({
    client: runtime.publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [getAddress(ownerAddress), [], [], []],
    deploySalt: "0x",
    environment: runtime.environment,
  });
}

function sameAddress(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/**
 * Reconstructs the mission policy from a wallet-signed delegation. Every term
 * is decoded from the signed caveats and validated against the server config,
 * so a tampered delegation can never widen the mission.
 */
async function policyFromDelegation(
  runtime: AppRuntime,
  delegation: Delegation,
): Promise<MissionPolicy> {
  const relayerAddress = runtime.config.relayerAddress;
  if (!relayerAddress) {
    throw new SetupRequiredError("the relayer/facilitator account is not configured");
  }
  const tokenAddress = runtime.config.token.address;
  let budget: bigint | null = null;
  let perCallMax: bigint | null = null;
  let validBefore: number | null = null;
  let sawRedeemer = false;
  let sawPolicy = false;

  for (const caveat of delegation.caveats) {
    if (
      runtime.config.enforcerAddress &&
      sameAddress(caveat.enforcer, runtime.config.enforcerAddress)
    ) {
      const terms = decodeMissionPolicyTerms(caveat.terms);
      if (!sameAddress(terms.token, tokenAddress)) {
        throw new PolicyError("delegation policy token mismatch");
      }
      const recipients = [terms.recipient0, terms.recipient1]
        .filter((address) => address !== "0x0000000000000000000000000000000000000000")
        .map((address) => getAddress(address));
      const expected = runtime.config.recipients.map((address) => getAddress(address));
      if (JSON.stringify(recipients) !== JSON.stringify(expected)) {
        throw new PolicyError(
          "delegation recipient allow-list does not match the mission config",
        );
      }
      perCallMax = terms.maxAmountPerCall;
      sawPolicy = true;
      continue;
    }
    let decoded: Record<string, unknown>;
    try {
      decoded = decodeCaveat({
        caveat,
        environment: runtime.environment,
      }) as unknown as Record<string, unknown>;
    } catch {
      continue;
    }
    if (decoded.type === "erc20TransferAmount") {
      if (!sameAddress(decoded.tokenAddress as string, tokenAddress)) {
        throw new PolicyError("delegation budget token mismatch");
      }
      budget = decoded.maxAmount as bigint;
    } else if (decoded.type === "timestamp") {
      if (Number(decoded.afterThreshold) !== 0) {
        throw new PolicyError("delegation validity must start immediately");
      }
      validBefore = Number(decoded.beforeThreshold);
    } else if (decoded.type === "redeemer") {
      const redeemers = (decoded.redeemers as string[]).map((value) =>
        getAddress(value),
      );
      if (!redeemers.includes(getAddress(relayerAddress))) {
        throw new PolicyError("delegation does not allow the configured relayer");
      }
      sawRedeemer = true;
    }
  }

  if (
    budget === null ||
    perCallMax === null ||
    validBefore === null ||
    !sawRedeemer ||
    !sawPolicy
  ) {
    throw new PolicyError("delegation is missing required mission caveats");
  }
  if (budget <= 0n || budget > 1_000_000n) {
    throw new PolicyError("delegation budget is outside the demo bounds");
  }
  if (perCallMax <= 0n || perCallMax > budget || perCallMax > runtime.config.perCallMax) {
    throw new PolicyError("delegation per-call cap is invalid");
  }
  const latest = await runtime.publicClient.getBlock();
  const blockNow = Number(latest.timestamp);
  if (
    validBefore <= blockNow ||
    validBefore > blockNow + runtime.config.validitySeconds + 600
  ) {
    throw new PolicyError("delegation validity window is outside the demo bounds");
  }
  return {
    chainId: runtime.config.chainId,
    token: runtime.config.token,
    budget,
    perCallMax,
    recipients: runtime.config.recipients.map((address) => getAddress(address)),
    validAfter: 0,
    validBefore,
    redeemer: getAddress(relayerAddress),
  };
}

/** Builds the unsigned root delegation plus the EIP-712 payload to sign. */
export async function prepareWalletMission(params: {
  runtime: AppRuntime;
  input: MissionDraftInput;
  ownerAddress: Address;
}): Promise<PreparedWalletMission> {
  const { runtime } = params;
  const ownerAddress = getAddress(params.ownerAddress);
  validateInput(runtime, params.input);
  if (!runtime.config.executorAddress) {
    throw new SetupRequiredError("executor address is not configured");
  }
  const policy = await buildPolicy(runtime, params.input.budgetUsdc);
  const smartAccount = await deriveSmartAccount(runtime, ownerAddress);

  // Local testnet: make sure the spending account can actually pay the budget
  // (mint test USDC and prefund ETH). Base Sepolia uses the faucet instead.
  await ensureLocalSpendingFunds({
    mode: runtime.config.mode,
    publicClient: runtime.publicClient,
    token: runtime.config.token.address,
    deployerWallet: runtime.deployerWallet,
    smartAccountAddress: smartAccount.address,
  });

  const delegation = buildRootDelegation({
    environment: runtime.environment,
    from: smartAccount.address,
    to: runtime.config.executorAddress,
    policy,
    enforcerAddress: runtime.config.enforcerAddress,
  });
  const signable = toDelegationStruct(delegation);
  return {
    ownerAddress,
    smartAccountAddress: smartAccount.address,
    delegation,
    typedData: {
      domain: {
        chainId: runtime.config.chainId,
        name: "DelegationManager",
        version: "1",
        verifyingContract: runtime.environment.DelegationManager,
      },
      types: withEip712Domain(SIGNABLE_DELEGATION_TYPED_DATA),
      primaryType: "Delegation",
      message: {
        delegate: signable.delegate,
        delegator: signable.delegator,
        authority: signable.authority,
        caveats: signable.caveats.map(({ enforcer, terms }) => ({ enforcer, terms })),
        salt: signable.salt.toString(),
      },
    },
  };
}

/**
 * Validates the wallet-signed root delegation: the delegator must be the smart
 * account derived from the owner, every caveat must match the server policy
 * (rebuilt with the client's own salt and validity window), and the signature
 * must recover to the owner. The server never needs the owner key.
 */
export async function submitWalletMission(params: {
  runtime: AppRuntime;
  store: Store;
  input: MissionDraftInput;
  ownerAddress: Address;
  delegation: Delegation;
  signature: Hex;
}): Promise<MissionRecord> {
  const { runtime, store } = params;
  const ownerAddress = getAddress(params.ownerAddress);
  const addresses = validateInput(runtime, params.input);
  if (!runtime.config.executorAddress) {
    throw new SetupRequiredError("executor address is not configured");
  }
  const smartAccount = await deriveSmartAccount(runtime, ownerAddress);
  if (!sameAddress(params.delegation.delegator, smartAccount.address)) {
    throw new PolicyError("delegation delegator is not the owner's smart account");
  }
  if (!sameAddress(params.delegation.delegate, runtime.config.executorAddress)) {
    throw new PolicyError("delegation delegate is not the configured executor");
  }
  if (params.delegation.authority !== ROOT_AUTHORITY) {
    throw new PolicyError("delegation is not a root delegation");
  }

  const policy = await policyFromDelegation(runtime, params.delegation);
  const rebuilt = buildRootDelegation({
    environment: runtime.environment,
    from: smartAccount.address,
    to: runtime.config.executorAddress,
    policy,
    enforcerAddress: runtime.config.enforcerAddress,
    salt: params.delegation.salt,
  });
  // JSON field order changes when the HTTP schema parses the delegation.
  // Compare the EIP-712 hash; unsigned args must match the SDK's defaults too.
  if (delegationHash(rebuilt) !== delegationHash(params.delegation) ||
      params.delegation.caveats.some((caveat, index) =>
        caveat.args.toLowerCase() !== rebuilt.caveats[index]?.args.toLowerCase())) {
    throw new PolicyError("signed delegation does not match the server policy");
  }

  const typedData = {
    domain: {
      chainId: runtime.config.chainId,
      name: "DelegationManager",
      version: "1",
      verifyingContract: runtime.environment.DelegationManager,
    },
    types: SIGNABLE_DELEGATION_TYPED_DATA,
    primaryType: "Delegation" as const,
  };
  const valid = await verifyTypedData({
    address: ownerAddress,
    ...typedData,
    message: toDelegationStruct({
      ...params.delegation,
      signature: "0x",
    }),
    signature: params.signature,
  });
  if (!valid) {
    throw new PolicyError("owner signature over the mission permission is invalid");
  }
  const signed: Delegation = { ...params.delegation, signature: params.signature };

  const existing = store.findMissionByRootHash(delegationHash(signed));
  if (existing) {
    const context = store.listEvents(existing.id).find((event) => event.type === "mission.context")?.payload;
    if (context?.task !== params.input.task ||
        JSON.stringify(context?.addresses) !== JSON.stringify(addresses) ||
        (context?.scenario ?? "research") !== (params.input.scenario ?? "research") ||
        (context?.positionUsd ?? "100") !== (params.input.positionUsd ?? "100")) {
      throw new PolicyError("this permission is already registered for a different mission task");
    }
    return existing;
  }

  // Make sure the smart account exists before redemptions can happen.
  const deploymentWallet = runtime.deployerWallet ?? runtime.executorWallet;
  if (deploymentWallet) {
    await deploySmartAccount({
      publicClient: runtime.publicClient,
      walletClient: deploymentWallet,
      smartAccount,
    });
  }
  await ensureLocalSpendingFunds({
    mode: runtime.config.mode,
    publicClient: runtime.publicClient,
    token: runtime.config.token.address,
    deployerWallet: runtime.deployerWallet,
    smartAccountAddress: smartAccount.address,
  });

  return store.createMission({
    title: params.input.title,
    context: { task: params.input.task, addresses, scenario: params.input.scenario ?? "research", positionUsd: params.input.positionUsd ?? "100" },
    policy,
    ownerAddress,
    smartAccountAddress: smartAccount.address,
    executorAddress: runtime.config.executorAddress,
    rootDelegation: signed,
    rootDelegationHash: delegationHash(signed),
    enforcerAddress: runtime.config.enforcerAddress,
  });
}

/** Revokes the mission root on-chain via the owner's smart account. */
export async function revokeMission(params: {
  runtime: AppRuntime;
  store: Store;
  missionId: string;
}): Promise<Hex> {
  const { runtime, store } = params;
  const mission = store.getMission(params.missionId);
  if (!runtime.owner || !runtime.executorWallet || !runtime.config.executorAddress) {
    throw new SetupRequiredError(
      "CLI revocation requires a configured test owner; the browser supports owner-signed revocation without a server owner key",
    );
  }
  const smartAccount = await createUserSmartAccount({
    publicClient: runtime.publicClient,
    owner: runtime.owner,
    environment: runtime.environment,
  });
  if (
    getAddress(smartAccount.address) !== getAddress(mission.smartAccountAddress)
  ) {
    throw new SetupRequiredError(
      "the configured owner key does not control this mission's smart account",
    );
  }
  const txHash = await sendSmartAccountCall({
    publicClient: runtime.publicClient,
    walletClient: runtime.executorWallet,
    smartAccount,
    entryPoint: runtime.environment.EntryPoint,
    beneficiary: runtime.config.executorAddress,
    to: runtime.environment.DelegationManager,
    data: encodeDisableDelegation(mission.rootDelegation),
  });
  store.updateMissionStatus(mission.id, "revoked");
  return txHash;
}
