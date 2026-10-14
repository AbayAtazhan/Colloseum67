/**
 * Deploys the stateless MissionPolicyEnforcer to the configured network using
 * the executor key (any funded EOA can deploy it).
 *
 * Usage:
 *   npm run contracts:compile
 *   npm run contracts:deploy-enforcer
 *
 * The printed address must be added to .env as MISSION_POLICY_ENFORCER_ADDRESS
 * before creating a mission.
 */
import "dotenv/config";
import { createPublicClient, createWalletClient, http } from "viem";
import { loadServerConfig, requireDeployerAccount } from "@/payments/config";
import { chainFor } from "@/payments/network";
import { loadArtifact } from "../tests/harness/artifacts";

async function main(): Promise<void> {
  const config = loadServerConfig();
  if (config.network === "local") {
    console.log(
      "local network selected; MissionPolicyEnforcer is deployed automatically by the test/demo harness",
    );
    return;
  }
  const chain = chainFor(config.chainId);
  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });
  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== config.chainId) {
    throw new Error(
      `RPC chain id ${liveChainId} does not match configured ${config.chainId}`,
    );
  }

  if (config.enforcerAddress) {
    const existing = await publicClient.getCode({
      address: config.enforcerAddress,
    });
    if (existing && existing !== "0x") {
      console.log(
        `MissionPolicyEnforcer already deployed at ${config.enforcerAddress}`,
      );
      return;
    }
  }

  const deployer = requireDeployerAccount(config);
  const balance = await publicClient.getBalance({ address: deployer.address });
  if (balance === 0n) {
    throw new Error(
      `deployer ${deployer.address} has no ${chain.name} ETH to pay for deployment; fund it and retry`,
    );
  }

  const artifact = await loadArtifact(
    "MissionPolicyEnforcer.sol",
    "MissionPolicyEnforcer",
  );
  const walletClient = createWalletClient({
    chain,
    transport: http(config.rpcUrl),
    account: deployer,
  });
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error("deployment receipt has no contract address");
  }
  console.log(`MissionPolicyEnforcer deployed at ${receipt.contractAddress}`);
  console.log(`tx: ${hash}`);
  console.log(
    `\nAdd to .env:\nMISSION_POLICY_ENFORCER_ADDRESS=${receipt.contractAddress}`,
  );
}

main().catch((error) => {
  console.error(
    "deployment failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
