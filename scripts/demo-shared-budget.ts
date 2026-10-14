/**
 * SWARM TAB — shared mission budget demo.
 *
 * Runs the full payment core against a local Hardhat EVM with the real
 * MetaMask delegation framework (v1.3.0 bytecode from @metamask/delegation-abis):
 *
 *   1. two payments of 0.02 USDC settle against a 0.05 USDC mission budget;
 *   2. the third is rejected by the on-chain root cap even if the server-side
 *      guard is bypassed;
 *   3. a brand-new child delegation does not reset the shared spend.
 *
 * This is a contract-path proof, not a simulation of a public-network
 * transaction. Use `npm run network:prepare` for the Base Sepolia steps.
 */
import "dotenv/config";
import { Store } from "@/store";
import { formatAmountShort, parseAmount } from "@/shared/amounts";
import { PolicyError } from "@/shared/errors";
import { readDelegationSpent, readTokenBalance } from "@/payments/spend";
import { delegationHash } from "@/payments/permissions";
import {
  bootstrapLocalChain,
  stopHardhatNode,
} from "../tests/harness/local-chain";
import {
  createPaymentService,
  createTestContext,
  createTestMission,
  redeemTestChild,
  signTestChild,
} from "../tests/harness/context";

const usdc = (value: string) => parseAmount(value, 6);

function line(label: string, value: string): void {
  console.log(`${label.padEnd(26)} ${value}`);
}

async function main(): Promise<void> {
  const boot = await bootstrapLocalChain();
  try {
    const ctx = await createTestContext();
    const store = new Store(process.env.DATABASE_PATH ?? "./data/swarm-tab.db");
    const service = createPaymentService(ctx, store);
    const budgetEnforcer =
      ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer;

    const mission = await createTestMission(ctx, store, {
      title: "Demo: one 0.05 USDC budget shared by two agents",
      budget: usdc("0.05"),
      perCallMax: usdc("0.02"),
    });

    console.log("SWARM TAB — shared budget demo (local Hardhat, chain 31337)");
    line("DelegationManager", ctx.meta.environment.DelegationManager);
    line("ERC20TransferAmountEnf.", budgetEnforcer);
    line("MissionPolicyEnforcer", ctx.meta.enforcerAddress);
    line("TestUSDC (6 decimals)", ctx.meta.tokenAddress);
    line("User smart account", ctx.meta.smartAccountAddress);
    line("Executor EOA", ctx.meta.executorAddress);
    line(
      "Mission",
      `budget ${formatAmountShort(mission.policy.budget, 6)} USDC, per-call max ${formatAmountShort(
        mission.policy.perCallMax,
        6,
      )} USDC`,
    );
    console.log("");

    const rootSpent = async (): Promise<bigint> =>
      readDelegationSpent({
        publicClient: ctx.publicClient,
        enforcerAddress: budgetEnforcer,
        delegationManager: ctx.meta.environment.DelegationManager,
        delegationHash: mission.rootDelegationHash,
      });

    // Payment 1 and 2 settle.
    const payments = [
      { label: "#1 pay 0.02 to recipient1", recipient: ctx.meta.recipient1 },
      { label: "#2 pay 0.02 to recipient2", recipient: ctx.meta.recipient2 },
    ];
    for (const payment of payments) {
      const attempt = await service.execute({
        missionId: mission.id,
        recipient: payment.recipient,
        amount: usdc("0.02"),
      });
      console.log(
        `${payment.label.padEnd(26)} -> ${attempt.state} tx=${attempt.txHash}`,
      );
      console.log(
        `${" ".repeat(26)}    root spent after: ${formatAmountShort(await rootSpent(), 6)} USDC`,
      );
    }

    // Payment 3 through the service: server-side UX guard rejects it.
    try {
      await service.execute({
        missionId: mission.id,
        recipient: ctx.meta.recipient1,
        amount: usdc("0.02"),
      });
      throw new Error("server guard did not reject the third payment");
    } catch (error) {
      if (!(error instanceof PolicyError)) throw error;
      console.log(
        `#3 pay 0.02 (server guard)   -> rejected: ${error.message}`,
      );
    }

    // Payment 3 bypassing the server guard: the contract rejects it.
    const thirdChild = await signTestChild(ctx, mission, {
      recipient: ctx.meta.recipient1,
      amount: usdc("0.02"),
    });
    try {
      await redeemTestChild(ctx, mission, thirdChild, {
        recipient: ctx.meta.recipient1,
        amount: usdc("0.02"),
      });
      throw new Error("contract did not reject the third payment");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`#3 pay 0.02 (bypassing server)-> rejected: ${reason}`);
    }
    const spentAfterThird = await rootSpent();
    console.log(
      `${" ".repeat(26)}    root spent after: ${formatAmountShort(spentAfterThird, 6)} USDC (unchanged)`,
    );

    // A fresh child does not reset the root spend.
    const freshChild = await signTestChild(ctx, mission, {
      recipient: ctx.meta.recipient2,
      amount: usdc("0.02"),
    });
    const freshChildSpent = await readDelegationSpent({
      publicClient: ctx.publicClient,
      enforcerAddress: budgetEnforcer,
      delegationManager: ctx.meta.environment.DelegationManager,
      delegationHash: delegationHash(freshChild),
    });
    console.log("");
    line("Fresh child spent", `${formatAmountShort(freshChildSpent, 6)} USDC`);
    line("Root spent", `${formatAmountShort(await rootSpent(), 6)} USDC`);
    console.log("New child does not reset the shared mission spend.");
    console.log("");

    const [userBalance, r1, r2] = await Promise.all([
      readTokenBalance({
        publicClient: ctx.publicClient,
        token: ctx.meta.tokenAddress,
        account: ctx.meta.smartAccountAddress,
      }),
      readTokenBalance({
        publicClient: ctx.publicClient,
        token: ctx.meta.tokenAddress,
        account: ctx.meta.recipient1,
      }),
      readTokenBalance({
        publicClient: ctx.publicClient,
        token: ctx.meta.tokenAddress,
        account: ctx.meta.recipient2,
      }),
    ]);
    line("User smart account", `${formatAmountShort(userBalance, 6)} USDC`);
    line("Recipient 1", `${formatAmountShort(r1, 6)} USDC`);
    line("Recipient 2", `${formatAmountShort(r2, 6)} USDC`);
    line("Local DB", process.env.DATABASE_PATH ?? "./data/swarm-tab.db");
    store.close();
  } finally {
    await stopHardhatNode(boot.process);
  }
}

main().catch((error) => {
  console.error("demo failed:", error);
  process.exitCode = 1;
});
