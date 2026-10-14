import { EXIT_DEMO_ADDRESSES } from "@/shared/exit-check";

/** Explicit external-source fixtures; no network or model call in tests. */
export function marketDataFetch(options: { outage?: boolean; wrongQuote?: boolean; emptyMetadata?: boolean } = {}) {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push(url.href);
    if (options.outage) return Response.json({ error: "offline" }, { status: 503 });
    if (url.hostname === "tokens.coingecko.com") return Response.json({ tokens: options.emptyMetadata ? [] : EXIT_DEMO_ADDRESSES.map((address) => ({ chainId: 8453, address, decimals: 18 })) });
    if (url.hostname === "api.dexscreener.com") {
      const address = url.pathname.split("/").at(-1)!;
      const first = address.toLowerCase() === EXIT_DEMO_ADDRESSES[0].toLowerCase();
      return Response.json([{
        chainId: "base", dexId: "fixture-dex", pairAddress: "0x1111111111111111111111111111111111111111",
        baseToken: { address, symbol: first ? "WETH" : "DEGEN" }, priceUsd: first ? "10" : "0.001",
        liquidity: { usd: first ? 1_000_000 : 10_000 }, volume: { h24: first ? 100_000 : 1_000 },
      }]);
    }
    if (url.hostname === "aggregator-api.kyberswap.com") {
      const tokenIn = url.searchParams.get("tokenIn")!;
      const amountIn = url.searchParams.get("amountIn")!;
      const first = tokenIn.toLowerCase() === EXIT_DEMO_ADDRESSES[0].toLowerCase();
      const micros = BigInt(amountIn) * (first ? 10_000_000n : 1_000n) / 10n ** 18n;
      return Response.json({ code: 0, data: { routeSummary: {
        tokenIn: options.wrongQuote ? "0x0000000000000000000000000000000000000001" : tokenIn,
        tokenOut: url.searchParams.get("tokenOut"), amountIn,
        amountOut: (micros * 98n / 100n).toString(), gasUsd: "0.01",
        route: [[{ exchange: "fixture-dex" }]],
      } } });
    }
    throw new Error(`unexpected fixture URL: ${url}`);
  };
  return { fetchImpl, seen };
}
