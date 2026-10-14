/**
 * Base Sepolia readiness report and funding checklist.
 *
 * Derives every public address involved in a real mission (deployer, executor,
 * relayer, owner, spending smart account, provider payees), checks balances and
 * framework contracts, deploys the smart account when the deployer is funded,
 * and prints exactly what is still missing.
 *
 * It never prints private keys and never asks for the user's MetaMask key.
 *
 * Usage: npm run network:prepare
 */
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
} from "viem";
import {
  loadServerConfig,
  requireDeployerAccount,
  requireOwnerAccount,
  requireRecipients,
} from "@/payments/config";
import { createUserSmartAccount, deploySmartAccount } from "@/payments/accounts";
import { readTokenBalance, readTokenMetadata } from "@/payments/spend";
import { formatAmountShort } from "@/shared/amounts";
import {
  FAUCET_LINKS,
  USDC_BASE_SEPOLIA,
  chainFor,
  resolveSmartAccountsEnvironment,
} from "@/payments/network";

/** Suggested testnet top-ups (the exact minimum is noted per row). */
const SUGGESTED_DEPLOYER_ETH = 20_000_000_000_000_000n; // 0.02 ETH
const SUGGESTED_RELAYER_ETH = 10_000_000_000_000_000n; // 0.01 ETH

async function main(): Promise<void> {
  const config = loadServerConfig();
  if (config.chainId !== 84532) {
    throw new Error(
      "network:prepare targets Base Sepolia; set SWARM_TAB_NETWORK=base-sepolia",
    );
  }
  const chain = chainFor(config.chainId);
  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });
  const environment = resolveSmartAccountsEnvironment(config.chainId);
  const recipients = requireRecipients(config);
  if (recipients.length < 2) {
    throw new Error(
      "ALLOWED_RECIPIENT_1 and ALLOWED_RECIPIENT_2 must both be set (one payee per provider)",
    );
  }

  console.log("Base Sepolia readiness report");
  console.log(`  rpc:     ${config.rpcUrl}`);
  console.log(`  chain:   ${await publicClient.getChainId()} (expected 84532)`);
  const metadata = await readTokenMetadata({
    publicClient,
    token: config.token.address,
  });
  console.log(
    `  token:   ${config.token.address} (${metadata.symbol}, ${metadata.decimals} decimals)`,
  );
  if (getAddress(config.token.address) !== USDC_BASE_SEPOLIA) {
    throw new Error(
      `USDC_ADDRESS must be the official Circle test token ${USDC_BASE_SEPOLIA}`,
    );
  }
  console.log(
    `  mission: budget ${formatAmountShort(config.budget, 6)} USDC, per call ${formatAmountShort(
      config.perCallMax,
      6,
    )} USDC`,
  );
  console.log("");

  const codeChecks: Array<[string, string]> = [
    ["DelegationManager", environment.DelegationManager],
    [
      "ERC20TransferAmountEnforcer",
      environment.caveatEnforcers.ERC20TransferAmountEnforcer,
    ],
    ["TimestampEnforcer", environment.caveatEnforcers.TimestampEnforcer],
    ["RedeemerEnforcer", environment.caveatEnforcers.RedeemerEnforcer],
  ];
  for (const [name, address] of codeChecks) {
    const code = await publicClient.getCode({ address: address as `0x${string}` });
    console.log(`  framework: ${name} ${code && code !== "0x" ? "ok" : "MISSING"}`);
  }

  // Public addresses.
  const owner = requireOwnerAccount(config);
  const smartAccount = await createUserSmartAccount({
    publicClient,
    owner,
    environment,
  });
  const balanceOf = async (address: `0x${string}`) =>
    publicClient.getBalance({ address });

  console.log("\nAddresses and balances");
  console.log(`  owner EOA (no funding needed):        ${owner.address}`);

  const executor = config.executorAddress;
  console.log(
    `  executor EOA (signs children, no ETH): ${executor ?? "not configured"}`,
  );
  console.log(
    `  relayer EOA (pays settlement gas):     ${config.relayerAddress ?? "not configured"}`,
  );
  console.log(
    `  deployer EOA (pays deployments):       ${config.deployerAddress ?? "not configured"}`,
  );
  console.log(`  spending smart account (needs USDC):   ${smartAccount.address}`);
  console.log(`  payee code provider:                   ${recipients[0]}`);
  console.log(`  payee activity provider:               ${recipients[1]}`);

  console.log("\nFunding this run needs:");
  if (config.deployerAddress) {
    const balance = await balanceOf(config.deployerAddress);
    console.log(
      `  deployer ETH:  ${formatEther(balance)} ETH now; suggested top-up ${formatEther(
        SUGGESTED_DEPLOYER_ETH,
      )} ETH (enforcer + smart account deployment)`,
    );
  }
  if (config.relayerAddress) {
    const balance = await balanceOf(config.relayerAddress);
    console.log(
      `  relayer ETH:   ${formatEther(balance)} ETH now; suggested top-up ${formatEther(
        SUGGESTED_RELAYER_ETH,
      )} ETH (x402 settlements)`,
    );
  }
  const usdcBalance = await readTokenBalance({
    publicClient,
    token: config.token.address,
    account: smartAccount.address,
  });
  console.log(
    `  smart account: ${formatAmountShort(usdcBalance, 6)} USDC now; needs at least ${formatAmountShort(
      config.budget,
      6,
    )} USDC (0.05 budget + margin)`,
  );

  // Deploy the smart account when deployment is funded.
  const deploymentWallet = config.deployerPrivateKey || config.executorPrivateKey
    ? createWalletClient({
        chain,
        transport: http(config.rpcUrl),
        account: requireDeployerAccount(config),
      })
    : null;
  if (deploymentWallet) {
    const deployerBalance = await balanceOf(deploymentWallet.account.address);
    const code = await publicClient.getCode({ address: smartAccount.address });
    if (code && code !== "0x") {
      console.log("\nSmart account: already deployed");
    } else if (deployerBalance > 0n) {
      try {
        const address = await deploySmartAccount({
          publicClient,
          walletClient: deploymentWallet,
          smartAccount,
        });
        console.log(`\nSmart account deployed: ${address}`);
      } catch (error) {
        console.log(
          `\nSmart account deployment failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      console.log(
        "\nSmart account: not deployed yet (deployer has 0 ETH; it will be deployed automatically during mission creation once funded)",
      );
    }
  }

  const blockers: string[] = [];
  if (config.enforcerAddress) {
    const code = await publicClient.getCode({
      address: config.enforcerAddress,
    });
    if (!code || code === "0x") {
      blockers.push(
        `MissionPolicyEnforcer has no code at ${config.enforcerAddress}; run npm run contracts:deploy-enforcer`,
      );
    }
  } else {
    blockers.push(
      "MISSION_POLICY_ENFORCER_ADDRESS is not set; run npm run contracts:deploy-enforcer",
    );
  }
  if (config.deployerAddress) {
    const balance = await balanceOf(config.deployerAddress);
    if (balance === 0n) {
      blockers.push(
        `deployer ${config.deployerAddress} has 0 ETH (needed for enforcer/smart-account deployment)`,
      );
    }
  }
  if (config.relayerAddress) {
    const balance = await balanceOf(config.relayerAddress);
    if (balance === 0n) {
      blockers.push(
        `relayer ${config.relayerAddress} has 0 ETH (needed for x402 settlement gas)`,
      );
    }
  }
  if (usdcBalance < config.budget) {
    blockers.push(
      `spending smart account ${smartAccount.address} has ${formatAmountShort(
        usdcBalance,
        6,
      )} USDC; fund it with at least ${formatAmountShort(config.budget, 6)} USDC via https://faucet.circle.com/ (Base Sepolia)`,
    );
  }

  if (blockers.length > 0) {
    console.log("\nBlockers:");
    for (const blocker of blockers) console.log(`  - ${blocker}`);
  } else {
    console.log(
      "\nEverything is funded. Next: npm run chain:check && npm run base:mission",
    );
  }

  console.log("\nFaucets:");
  for (const link of FAUCET_LINKS) console.log(`  - ${link}`);
}

main().catch((error) => {
  console.error(
    "network preparation failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
