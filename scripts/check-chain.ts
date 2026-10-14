/**
 * Checks the configured network before a mission is created:
 *  - chain id matches SWARM_TAB_NETWORK;
 *  - the token really is the official Circle test USDC (symbol, decimals, address);
 *  - the delegation framework contracts and the custom enforcer have code;
 *  - executor / owner funds are sufficient, with faucet hints.
 *
 * Usage: npm run chain:check
 */
import "dotenv/config";
import { createPublicClient, formatEther, getAddress, http } from "viem";
import { loadServerConfig, requireRecipients } from "@/payments/config";
import { createUserSmartAccount } from "@/payments/accounts";
import { readTokenBalance, readTokenMetadata } from "@/payments/spend";
import { formatAmountShort } from "@/shared/amounts";
import {
  FAUCET_LINKS,
  USDC_BASE_SEPOLIA,
  chainFor,
  resolveSmartAccountsEnvironment,
} from "@/payments/network";

async function main(): Promise<void> {
  const config = loadServerConfig();
  const chain = chainFor(config.chainId);
  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });

  console.log(`network:        ${config.network} (chain ${config.chainId})`);
  console.log(`rpc:            ${config.rpcUrl}`);
  console.log(`token:          ${config.token.address} (${config.token.symbol})`);

  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== config.chainId) {
    throw new Error(
      `RPC chain id ${liveChainId} does not match configured ${config.chainId}`,
    );
  }

  const metadata = await readTokenMetadata({
    publicClient,
    token: config.token.address,
  });
  console.log(`token metadata: ${metadata.symbol} / ${metadata.decimals} decimals`);
  if (metadata.decimals !== 6 || metadata.symbol !== "USDC") {
    throw new Error("configured token is not a 6-decimals USDC token");
  }
  if (
    config.chainId === 84532 &&
    getAddress(config.token.address) !== USDC_BASE_SEPOLIA
  ) {
    throw new Error(
      `USDC_ADDRESS on Base Sepolia must be the official ${USDC_BASE_SEPOLIA}`,
    );
  }

  const environment = resolveSmartAccountsEnvironment(config.chainId);
  const codeChecks: Array<[string, string]> = [
    ["DelegationManager", environment.DelegationManager],
    [
      "ERC20TransferAmountEnforcer",
      environment.caveatEnforcers.ERC20TransferAmountEnforcer,
    ],
    ["TimestampEnforcer", environment.caveatEnforcers.TimestampEnforcer],
    ["LimitedCallsEnforcer", environment.caveatEnforcers.LimitedCallsEnforcer],
    ["RedeemerEnforcer", environment.caveatEnforcers.RedeemerEnforcer],
  ];
  if (config.enforcerAddress) {
    codeChecks.push(["MissionPolicyEnforcer", config.enforcerAddress]);
  }
  for (const [name, address] of codeChecks) {
    const code = await publicClient.getCode({ address: address as `0x${string}` });
    if (!code || code === "0x") {
      throw new Error(`${name} has no code at ${address}`);
    }
    console.log(`contract:       ${name} ok at ${address}`);
  }

  if (!config.enforcerAddress) {
    console.log(
      "warning:        MISSION_POLICY_ENFORCER_ADDRESS is not set; missions would only have the standard budget/timestamp/redeemer caveats",
    );
  }

  const recipients = requireRecipients(config);
  console.log(`recipients:     ${recipients.join(", ")}`);

  const showRole = async (
    label: string,
    address: string | null,
    keyName: string,
  ) => {
    if (!address) {
      console.log(`${label}: ${keyName} not set`);
      return;
    }
    const balance = await publicClient.getBalance({
      address: address as `0x${string}`,
    });
    console.log(
      `${label}: ${address} (${formatEther(balance)} ETH${balance === 0n ? " — needs funding" : ""})`,
    );
  };
  await showRole("deployer", config.deployerAddress, "DEPLOYER_PRIVATE_KEY");
  await showRole("executor", config.executorAddress, "EXECUTOR_PRIVATE_KEY");
  await showRole("relayer", config.relayerAddress, "RELAYER_PRIVATE_KEY");

  if (config.ownerPrivateKey) {
    const { privateKeyToAccount } = await import("viem/accounts");
    const smartAccount = await createUserSmartAccount({
      publicClient,
      owner: privateKeyToAccount(config.ownerPrivateKey),
      environment,
    });
    const code = await publicClient.getCode({
      address: smartAccount.address,
    });
    console.log(
      `user account:   ${smartAccount.address} (${code && code !== "0x" ? "deployed" : "not deployed yet"})`,
    );
    const balance = await readTokenBalance({
      publicClient,
      token: config.token.address,
      account: smartAccount.address,
    });
    console.log(
      `user USDC:      ${balance} minimal units (${formatAmountShort(balance, 6)} USDC)`,
    );
  } else {
    console.log("user account:   USER_OWNER_PRIVATE_KEY not set");
  }
  console.log(
    `mission:        budget ${config.budget} / per-call ${config.perCallMax} minimal units`,
  );

  console.log("\nfaucets:");
  for (const link of FAUCET_LINKS) console.log(`  - ${link}`);
}

main().catch((error) => {
  console.error("chain check failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
