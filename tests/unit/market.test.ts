import { describe, expect, it, vi } from "vitest";
import { fetchExitFacts, parseMarketArgs, readMarketToken, sizePosition } from "@/providers/market";
import { requestHash } from "@/providers/types";
import { buildExitCheckReport } from "@/agents/exit-report";
import { executeToolCall } from "@/agents/tools";
import type { X402AgentClient } from "@/x402/client";
import { EXIT_DEMO_ADDRESSES, type ExitTokenFact } from "@/shared/exit-check";
import { marketDataFetch } from "../harness/market-data";

const args = () => parseMarketArgs(new URLSearchParams({ address: EXIT_DEMO_ADDRESSES[0], compareAddress: EXIT_DEMO_ADDRESSES[1], positionUsd: "100" }));
const context = (fetch: typeof globalThis.fetch) => ({ chainId: 31337, rpcUrl: "http://unused.test", fetch });

describe("Base token exit observations", () => {
  it("sizes positions exactly with integer arithmetic, including tiny token prices", () => {
    expect(sizePosition("100", "10", 18)).toBe(10n * 10n ** 18n);
    expect(sizePosition("100", "0.00000001", 18)).toBe(10_000_000_000n * 10n ** 18n);
    expect(sizePosition("1.23", "0.1", 0)).toBe(12n);
    expect(() => sizePosition("100", "0", 18)).toThrow();
  });
  it("includes position and depth in the idempotency request hash and rejects URL injection", () => {
    const base = args();
    expect(requestHash("exit", base)).not.toBe(requestHash("exit", { ...base, depth: true }));
    expect(requestHash("exit", base)).not.toBe(requestHash("exit", { ...base, positionUsd: "200" }));
    expect(() => parseMarketArgs(new URLSearchParams({ address: base.address, url: "https://attacker.test" }))).toThrow();
    expect(() => parseMarketArgs(new URLSearchParams({ address: base.address, positionUsd: "0" }))).toThrow();
  });
  it("excludes quote-token prices and selects the highest reported eligible pair", async () => {
    const first = EXIT_DEMO_ADDRESSES[0];
    const fetch: typeof globalThis.fetch = async () => Response.json([
      { chainId: "base", dexId: "wrong-price", pairAddress: EXIT_DEMO_ADDRESSES[1], baseToken: { address: EXIT_DEMO_ADDRESSES[1], symbol: "OTHER" }, priceUsd: "999", liquidity: { usd: 9_000_000 } },
      { chainId: "base", dexId: "small", pairAddress: first, baseToken: { address: first, symbol: "WETH" }, priceUsd: "10", liquidity: { usd: 100 } },
      { chainId: "base", dexId: "large", pairAddress: first, baseToken: { address: first, symbol: "WETH" }, priceUsd: "11", liquidity: { usd: 1000 } },
    ]);
    const result = await readMarketToken(first, context(fetch));
    expect(result.priceUsd).toBe("11"); expect(result.liquidityUsd).toBe(1000);
    expect(result.dex).toBe("large");
  });
  it("returns USD-sized quotes while keeping market chain separate from the payment chain", async () => {
    const { fetchImpl } = marketDataFetch();
    const result = await fetchExitFacts(args(), context(fetchImpl));
    const tokens = result.facts.tokens as ExitTokenFact[];
    expect(result.blockNumber).toBeNull(); expect(result.facts.analysisChainId).toBe(8453);
    expect(tokens.map((token) => token.quotedUsdc)).toEqual(["98", "98"]);
    expect(tokens[0].quoteGapPct).toBe(2); expect(tokens[0].gasUsd).toBe("0.01");
    expect(tokens[1].tokenAmount).toBe("100000");
  });
  it("preserves unknown states during outages and never invents token decimals", async () => {
    for (const options of [{ outage: true }, { emptyMetadata: true }]) {
      const { fetchImpl, seen } = marketDataFetch(options);
      const result = await fetchExitFacts(args(), context(fetchImpl));
      for (const token of result.facts.tokens as ExitTokenFact[]) {
        expect(token.routeStatus).toBe("unavailable"); expect(token.quotedUsdc).toBeNull();
      }
      expect(seen.some((url) => url.includes("kyberswap"))).toBe(false);
    }
  });
  it("rejects quotes returned for a different token", async () => {
    const { fetchImpl } = marketDataFetch({ wrongQuote: true });
    const result = await fetchExitFacts(args(), context(fetchImpl));
    for (const token of result.facts.tokens as ExitTokenFact[]) {
      expect(token.routeStatus).toBe("unavailable"); expect(token.quotedUsdc).toBeNull();
      expect(token.quoteError).toBe("quote_input_mismatch");
    }
  });
  it("cannot turn a model claim into a verified report without paid facts", () => {
    const report = buildExitCheckReport([], EXIT_DEMO_ADDRESSES, "100");
    expect(report.tokens.every((token) => token.exit === null)).toBe(true);
    expect(report.conclusion).toContain("0 of 2");
  });
  it("rejects an agent tool call outside mission scope before payment", async () => {
    const requestPaidData = vi.fn();
    const result = await executeToolCall({ toolName: "exit_quotes", rawArguments: JSON.stringify({
      providerId: "exit", address: "0x0000000000000000000000000000000000000001",
    }), client: { requestPaidData } as unknown as X402AgentClient, agentRunId: "test", budget: { paidAttempts: 0, maxPaidAttempts: 3 },
      constraints: { allowedTools: ["exit_quotes"], addresses: EXIT_DEMO_ADDRESSES, positionUsd: "100" } });
    expect(result.result).toBeNull(); expect(requestPaidData).not.toHaveBeenCalled();
  });
});
