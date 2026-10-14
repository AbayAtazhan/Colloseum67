import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import type { Delegation } from "@metamask/smart-accounts-kit";
import { Store, StoreError } from "@/store/store";
import type { MissionPolicy } from "@/shared/types";

const USER = getAddress("0x1000000000000000000000000000000000000001");
const EXECUTOR = getAddress("0x2000000000000000000000000000000000000002");
const R1 = getAddress("0x3000000000000000000000000000000000000003");
const R2 = getAddress("0x4000000000000000000000000000000000000004");
const TOKEN = getAddress("0x5000000000000000000000000000000000000005");
const HASH = `0x${"ab".repeat(32)}` as Hex;

function fakeDelegation(): Delegation {
  return {
    delegate: EXECUTOR,
    delegator: USER,
    authority: `0x${"ff".repeat(32)}` as Hex,
    caveats: [],
    salt: "0x",
    signature: "0x",
  };
}

function policy(): MissionPolicy {
  const now = Math.floor(Date.now() / 1000);
  return {
    chainId: 84532,
    token: { address: TOKEN, symbol: "USDC", decimals: 6 },
    budget: 50_000n,
    perCallMax: 20_000n,
    recipients: [R1, R2],
    validAfter: now - 60,
    validBefore: now + 3600,
    redeemer: EXECUTOR,
  };
}

function newStore(): Store {
  return new Store(":memory:");
}

function createMission(store: Store) {
  return store.createMission({
    title: "mission",
    policy: policy(),
    ownerAddress: USER,
    smartAccountAddress: USER,
    executorAddress: EXECUTOR,
    rootDelegation: fakeDelegation(),
    rootDelegationHash: HASH,
    enforcerAddress: getAddress("0x6000000000000000000000000000000000000006"),
  });
}

describe("store", () => {
  it("persists a mission and reads the policy with bigint amounts", () => {
    const store = newStore();
    const mission = createMission(store);
    const loaded = store.getMission(mission.id);
    expect(loaded.policy.budget).toBe(50_000n);
    expect(loaded.policy.perCallMax).toBe(20_000n);
    expect(loaded.policy.recipients).toEqual([R1, R2]);
    expect(loaded.rootDelegationHash).toBe(HASH);
    expect(loaded.status).toBe("active");
    store.close();
  });

  it("enforces the payment state machine", () => {
    const store = newStore();
    const mission = createMission(store);
    const attempt = store.createPaymentAttempt({
      missionId: mission.id,
      recipient: R1,
      amount: 20_000n,
    });
    expect(attempt.state).toBe("requested");

    store.transitionPaymentAttempt(attempt.id, "authorized", {
      childDelegation: fakeDelegation(),
      delegationHash: HASH,
    });
    store.transitionPaymentAttempt(attempt.id, "submitted");
    expect(() => store.transitionPaymentAttempt(attempt.id, "settled")).not.toThrow();
    expect(() => store.transitionPaymentAttempt(attempt.id, "settled")).toThrow(
      StoreError,
    );
    expect(() => store.transitionPaymentAttempt(attempt.id, "rejected")).toThrow(
      StoreError,
    );
    store.close();
  });

  it("refuses a receipt for a non-settled attempt and sums settled spend", () => {
    const store = newStore();
    const mission = createMission(store);

    const settled = store.createPaymentAttempt({
      missionId: mission.id,
      recipient: R1,
      amount: 20_000n,
    });
    store.transitionPaymentAttempt(settled.id, "authorized");
    store.transitionPaymentAttempt(settled.id, "submitted");
    store.transitionPaymentAttempt(settled.id, "settled", {
      txHash: `0x${"12".repeat(32)}` as Hex,
    });
    store.insertReceipt({
      attemptId: settled.id,
      missionId: mission.id,
      txHash: `0x${"12".repeat(32)}` as Hex,
      blockNumber: 7,
      recipient: R1,
      amount: 20_000n,
      spentAfter: 20_000n,
    });
    expect(store.computeMissionSpent(mission.id)).toBe(20_000n);

    const rejected = store.createPaymentAttempt({
      missionId: mission.id,
      recipient: R2,
      amount: 20_000n,
    });
    store.transitionPaymentAttempt(rejected.id, "rejected", {
      errorKind: "policy",
      reason: "allowance-exceeded",
    });
    expect(() =>
      store.insertReceipt({
        attemptId: rejected.id,
        missionId: mission.id,
        txHash: `0x${"34".repeat(32)}` as Hex,
        blockNumber: 8,
        recipient: R2,
        amount: 20_000n,
        spentAfter: 40_000n,
      }),
    ).toThrow(StoreError);
    expect(store.computeMissionSpent(mission.id)).toBe(20_000n);
    store.close();
  });

  it("records agent runs and events", () => {
    const store = newStore();
    const mission = createMission(store);
    const runA = store.createAgentRun({
      missionId: mission.id,
      agentName: "researcher-a",
    });
    const runB = store.createAgentRun({
      missionId: mission.id,
      agentName: "researcher-b",
    });
    store.finishAgentRun(runA.id, "completed");
    expect(store.getAgentRun(runA.id).status).toBe("completed");
    expect(store.getAgentRun(runB.id).status).toBe("running");
    expect(store.listAgentRuns(mission.id)).toHaveLength(2);

    const events = store.listEvents(mission.id);
    expect(events.map((event) => event.type)).toContain("mission.created");
    const runEvents = events.filter((event) => event.type.includes("agent"));
    expect(runEvents).toHaveLength(0); // agent runs are not events by design
    store.close();
  });
});
