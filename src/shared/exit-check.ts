import type { Address } from "viem";

export type MissionScenario = "research" | "exit-check";

export const EXIT_DEMO_ADDRESSES: Address[] = [
  "0x4200000000000000000000000000000000000006",
  "0x4ed4e862860bed51a9570b96d89af5e1b0efefed",
];
export const EXIT_DEMO_TASK = "Compare the liquidity of these two Base tokens and check indicative token-to-USDC sell routes for the selected USD position size in each. Explain the quoted proceeds, data gaps and the shared spending limit. Do not execute any trade.";

export interface MarketTokenFact {
  address: Address;
  symbol: string;
  status: "observed" | "no_market" | "unavailable";
  priceUsd: string | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  pairAddress: string | null;
  dex: string | null;
  sourceUrl: string;
  observedAt: number;
  error: string | null;
}

export interface ExitTokenFact extends MarketTokenFact {
  routeStatus: "quoted" | "no_route" | "unavailable";
  decimals: number | null;
  sellAmount: string | null;
  tokenAmount: string | null;
  quotedUsdc: string | null;
  gasUsd: string | null;
  referenceValueUsd: string | null;
  quoteGapPct: number | null;
  exchanges: string[];
  quoteObservedAt: number | null;
  quoteSourceUrl: string | null;
  quoteError: string | null;
}

export interface ExitCheckReport {
  analysisChainId: 8453;
  positionUsd: string;
  tokens: Array<{
    market: MarketTokenFact | null;
    exit: ExitTokenFact | null;
    address: Address;
    paymentIds: string[];
  }>;
  conclusion: string;
  depthCheck: "completed" | "budget_blocked" | "unavailable" | "not_requested";
  limitations: string[];
}
