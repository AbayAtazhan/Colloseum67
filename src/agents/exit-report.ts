import type { Address } from "viem";
import type { Purchase } from "@/shared/types";
import type { ExitCheckReport, ExitTokenFact, MarketTokenFact } from "@/shared/exit-check";

/** Product output comes from paid, cached provider facts, never model prose. */
export function buildExitCheckReport(purchases: Purchase[], addresses: Address[], positionUsd: string): ExitCheckReport {
  const tokens = addresses.map((address) => ({ address, market: null as MarketTokenFact | null,
    exit: null as ExitTokenFact | null, paymentIds: [] as string[] }));
  let depthCheck: ExitCheckReport["depthCheck"] = "not_requested";
  for (const purchase of purchases) {
    if (purchase.providerId !== "market" && purchase.providerId !== "exit") continue;
    const request = JSON.parse(purchase.requestJson) as { depth?: boolean };
    if (request.depth) {
      depthCheck = purchase.state === "settled" && purchase.resultJson ? "completed"
        : purchase.reason?.includes("insufficient_funds") ? "budget_blocked" : "unavailable";
      continue;
    }
    if (purchase.state !== "settled" || !purchase.resultJson) continue;
    const facts = JSON.parse(purchase.resultJson) as { analysisChainId?: number; kind?: string; tokens?: unknown[] };
    if (facts.analysisChainId !== 8453 || !Array.isArray(facts.tokens)) continue;
    for (const raw of facts.tokens) {
      if (!raw || typeof raw !== "object" || !("address" in raw) || typeof raw.address !== "string") continue;
      const rawAddress = raw.address;
      const token = tokens.find((item) => item.address.toLowerCase() === rawAddress.toLowerCase());
      if (!token) continue;
      if (purchase.providerId === "market" && facts.kind === "market_snapshot") token.market = raw as MarketTokenFact;
      if (purchase.providerId === "exit" && facts.kind === "exit_quotes") token.exit = raw as ExitTokenFact;
      if (!token.paymentIds.includes(purchase.paymentId)) token.paymentIds.push(purchase.paymentId);
    }
  }
  const quoted = tokens.filter((token) => token.exit?.routeStatus === "quoted" && token.exit.quotedUsdc !== null);
  const conclusion = quoted.length === tokens.length
    ? `Indicative USDC sell routes were found for ${quoted.length} token${quoted.length === 1 ? "" : "s"} at the requested $${positionUsd} size. Compare the quoted proceeds and gas below; successful execution has not been tested.`
    : `${quoted.length} of ${tokens.length} tokens returned an indicative USDC sell route. Missing quotes remain unverified; missing data is not proof that a token cannot be sold.`;
  return { analysisChainId: 8453, positionUsd, tokens, conclusion, depthCheck,
    limitations: [
      "Prices and routes are dated snapshots. Refresh by running a new mission before using a quote.",
      "Liquidity is for the highest reported eligible pair, not the whole market.",
      "Quote gap compares separate source snapshots; it is not measured slippage. Gas is shown separately.",
      "Wallet balances, approvals, transfer taxes, restrictions and successful execution are unverified. No trade is submitted.",
      "Upstream APIs are publicly available. Test USDC pays the SWARM TAB services for collecting, sizing and comparing their data.",
    ] };
}
