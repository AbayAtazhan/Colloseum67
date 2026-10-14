import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Chain,
} from "viem";
import { hardhat } from "viem/chains";
import type { Delegation, MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { createUserSmartAccount } from "@/payments/accounts";
import type { BoundWalletClient, ReadClient } from "@/payments/clients";
import { PaymentService, type PaymentContext } from "@/payments/service";
import { executeRedemption, type ExecutionOutcome } from "@/payments/executor";
import {
  buildOneShotChildDelegation,
  buildRootDelegation,
  delegationHash,
  signDelegationWithAccount,
  signRootDelegation,
} from "@/payments/permissions";
import { parseAmount } from "@/shared/amounts";
import type { MissionPolicy, MissionRecord } from "@/shared/types";
import type { Store } from "@/store";
import {
  CONTEXT_FILE,
  TEST_ACCOUNTS,
  testAccount,
  type ChainContextMeta,
} from "./local-chain";

export interface TestContext {
  meta: ChainContextMeta;
  chain: Chain;
  publicClient: ReadClient;
  ownerWallet: BoundWalletClient;
  executorWallet: BoundWalletClient;
  relayerWallet: BoundWalletClient;
  deployerWallet: BoundWalletClient;
  smartAccount: MetaMaskSmartAccount;
  accounts: {
    owner: ReturnType<typeof testAccount>;
    executor: ReturnType<typeof testAccount>;
    recipient1: ReturnType<typeof testAccount>;
    recipient2: ReturnType<typeof testAccount>;
    attacker: ReturnType<typeof testAccount>;
    deployer: ReturnType<typeof testAccount>;
    relayer: ReturnType<typeof testAccount>;
  };
}

export async function createTestContext(): Promise<TestContext> {
  const meta = JSON.parse(await readFile(CONTEXT_FILE, "utf8")) as ChainContextMeta;
  const chain = {
    ...hardhat,
    rpcUrls: { default: { http: [meta.rpcUrl] } },
  } as Chain;
  const publicClient = createPublicClient({
    chain,
    transport: http(meta.rpcUrl),
  }) as ReadClient;
  const walletFor = (index: number): BoundWalletClient =>
    createWalletClient({
      chain,
      transport: http(meta.rpcUrl),
      account: testAccount(index),
    }) as BoundWalletClient;

  const accounts = {
    owner: testAccount(TEST_ACCOUNTS.owner),
    executor: testAccount(TEST_ACCOUNTS.executor),
    recipient1: testAccount(TEST_ACCOUNTS.recipient1),
    recipient2: testAccount(TEST_ACCOUNTS.recipient2),
    attacker: testAccount(TEST_ACCOUNTS.attacker),
    deployer: testAccount(TEST_ACCOUNTS.deployer),
    relayer: testAccount(TEST_ACCOUNTS.relayer),
  };

  const smartAccount = await createUserSmartAccount({
    publicClient,
    owner: accounts.owner,
    environment: meta.environment,
  });

  return {
    meta,
    chain,
    publicClient,
    ownerWallet: walletFor(TEST_ACCOUNTS.owner),
    executorWallet: walletFor(TEST_ACCOUNTS.executor),
    relayerWallet: walletFor(TEST_ACCOUNTS.relayer),
    deployerWallet: walletFor(TEST_ACCOUNTS.deployer),
    smartAccount,
    accounts,
  };
}

export function createPaymentService(
  ctx: TestContext,
  store: Store,
  overrides?: Partial<PaymentContext>,
): PaymentService {
  return new PaymentService({
    store,
    publicClient: ctx.publicClient,
    walletClient: ctx.executorWallet,
    executor: ctx.accounts.executor,
    environment: ctx.meta.environment,
    delegationManager: ctx.meta.environment.DelegationManager,
    chainId: ctx.meta.chainId,
    enforcerAddress: ctx.meta.enforcerAddress,
    budgetEnforcerAddress:
      ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
    validForSeconds: 600,
    ...overrides,
  });
}

export interface CreateTestMissionOptions {
  title?: string;
  budget?: bigint;
  perCallMax?: bigint;
  recipients?: Address[];
  validForSeconds?: number;
  validAfter?: number;
  /** Override the delegator smart account (e.g. one with zero funds). */
  smartAccount?: MetaMaskSmartAccount;
  /** Root redeemer (defaults to the executor; x402 missions use the relayer). */
  redeemer?: Address;
}

export async function createTestMission(
  ctx: TestContext,
  store: Store,
  options: CreateTestMissionOptions = {},
): Promise<MissionRecord> {
  const latestBlock = await ctx.publicClient.getBlock();
  const now = Number(latestBlock.timestamp);
  const recipients =
    options.recipients ??
    [getAddress(ctx.meta.recipient1), getAddress(ctx.meta.recipient2)];
  const smartAccount = options.smartAccount ?? ctx.smartAccount;
  const policy: MissionPolicy = {
    chainId: ctx.meta.chainId,
    token: {
      address: ctx.meta.tokenAddress,
      symbol: "USDC",
      decimals: 6,
    },
    budget: options.budget ?? parseAmount("0.05", 6),
    perCallMax: options.perCallMax ?? parseAmount("0.02", 6),
    recipients: recipients.map((address) => getAddress(address)),
    validAfter: options.validAfter ?? 0,
    validBefore: now + (options.validForSeconds ?? 3600),
    redeemer: options.redeemer ?? ctx.meta.executorAddress,
  };

  const unsignedRoot = buildRootDelegation({
    environment: ctx.meta.environment,
    from: smartAccount.address,
    to: ctx.meta.executorAddress,
    policy,
    enforcerAddress: ctx.meta.enforcerAddress,
  });
  const rootDelegation = await signRootDelegation(
    smartAccount,
    unsignedRoot,
    ctx.meta.chainId,
  );
  return store.createMission({
    title: options.title ?? "SWARM TAB test mission",
    policy,
    ownerAddress: ctx.meta.ownerAddress,
    smartAccountAddress: smartAccount.address,
    executorAddress: ctx.meta.executorAddress,
    rootDelegation,
    rootDelegationHash: delegationHash(rootDelegation),
    enforcerAddress: ctx.meta.enforcerAddress,
  });
}

export interface SignTestChildOptions {
  recipient: Address;
  amount: bigint;
  exactCalldata?: boolean;
  validUntil?: number;
  now?: number;
  /** Override the per-call cap used in the child's own caveats/scope. */
  perCallMaxOverride?: bigint;
}

/** Builds and signs a one-shot child delegation for direct-chain tests. */
export async function signTestChild(
  ctx: TestContext,
  mission: MissionRecord,
  options: SignTestChildOptions,
): Promise<Delegation> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const policy = options.perCallMaxOverride
    ? { ...mission.policy, perCallMax: options.perCallMaxOverride }
    : mission.policy;
  const unsigned = buildOneShotChildDelegation({
    environment: ctx.meta.environment,
    from: ctx.meta.executorAddress,
    to: ctx.meta.executorAddress,
    parentDelegation: mission.rootDelegation,
    policy,
    enforcerAddress: mission.enforcerAddress,
    recipient: options.recipient,
    amount: options.amount,
    validUntil: options.validUntil ?? now + 600,
    exactCalldata: options.exactCalldata ?? true,
    now: options.now,
  });
  return signDelegationWithAccount(
    ctx.accounts.executor,
    unsigned,
    ctx.meta.chainId,
    ctx.meta.environment.DelegationManager,
  );
}

/** Redeems a signed child delegation directly (bypasses server-side policy). */
export async function redeemTestChild(
  ctx: TestContext,
  mission: MissionRecord,
  child: Delegation,
  options: { recipient: Address; amount: bigint },
): Promise<ExecutionOutcome> {
  return executeRedemption({
    publicClient: ctx.publicClient,
    walletClient: ctx.executorWallet,
    delegationManager: ctx.meta.environment.DelegationManager,
    token: mission.policy.token.address,
    recipient: options.recipient,
    amount: options.amount,
    child,
    root: mission.rootDelegation,
    budgetEnforcerAddress:
      ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
    rootDelegationHash: mission.rootDelegationHash,
  });
}
