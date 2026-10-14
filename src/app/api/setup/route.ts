import { NextResponse } from "next/server";
import { loadAppRuntime } from "@/payments/runtime";
import { loadServerConfig } from "@/payments/config";
import { EXIT_DEMO_ADDRESSES, EXIT_DEMO_TASK } from "@/shared/exit-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public setup state: public addresses, token metadata and whether the
 * DeepSeek key / fixture mode is active. Never returns private keys.
 */
export async function GET() {
  try {
    const app = loadAppRuntime();
    const server = app.local ? null : loadServerConfig();
    const demoAddresses = app.local
      ? [app.local.tokenAddress, app.local.environment.DelegationManager]
      : server
        ? [server.token.address, app.environment.DelegationManager]
        : [app.environment.DelegationManager];
    return NextResponse.json({
      mode: app.config.mode,
      hostedDemo: process.env.SWARM_TAB_HOSTED_DEMO === "1",
      network: app.config.network,
      chainId: app.config.chainId,
      rpcUrl: process.env.SWARM_TAB_WALLET_RPC_URL ?? app.config.rpcUrl,
      token: app.config.token,
      budget: app.config.budget.toString(),
      perCallMax: app.config.perCallMax.toString(),
      recipients: app.config.recipients,
      validitySeconds: app.config.validitySeconds,
      executorAddress: app.config.executorAddress,
      relayerAddress: app.config.relayerAddress,
      ownerAddress: app.config.ownerAddress,
      enforcerAddress: app.config.enforcerAddress,
      delegationManager: app.environment.DelegationManager,
      entryPoint: app.environment.EntryPoint,
      providerPayTo: app.config.providerPayTo,
      explorerBaseUrl: app.config.explorerBaseUrl,
      deepseek: {
        hasKey: app.config.hasDeepSeekKey,
        fakeLlm: app.config.fakeLlm,
        model: process.env.DEEPSEEK_MODEL ?? "deepseek-flash",
      },
      local: app.local
        ? {
            chainId: app.local.chainId,
            rpcUrl: process.env.SWARM_TAB_WALLET_RPC_URL ?? app.local.rpcUrl,
            tokenAddress: app.local.tokenAddress,
            enforcerAddress: app.local.enforcerAddress,
            smartAccountAddress: app.local.smartAccountAddress,
          }
        : null,
      demoAddresses: demoAddresses.map(String),
      exitDemo: { addresses: EXIT_DEMO_ADDRESSES, task: EXIT_DEMO_TASK, analysisChainId: 8453, positionUsd: "100" },
      revokeAvailable: Boolean(app.owner && (app.relayerWallet ?? app.executorWallet)),
      providers: Object.values(app.providers).map((provider) => ({
        id: provider.id,
        name: provider.name,
        description: provider.description,
        path: provider.path,
        price: provider.price.toString(),
        payTo: provider.payTo,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "setup_required",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
