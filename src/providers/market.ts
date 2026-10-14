import { formatUnits, getAddress, parseUnits, type Address } from "viem";
import { z } from "zod";
import { ValidationError } from "@/shared/errors";
import type { ExitTokenFact, MarketTokenFact } from "@/shared/exit-check";
import { parseProviderArgs, type ProviderExecutionContext, type ProviderRequestArgs, type ProviderResult } from "./types";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TOKEN_LIST_URL = "https://tokens.coingecko.com/base/all.json";
const QUOTE_URL = "https://aggregator-api.kyberswap.com/base/api/v1/routes";
const decimal = z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/).max(80);
const positionSchema = z.string().regex(/^[0-9]+(?:\.[0-9]{1,2})?$/)
  .refine((value) => Number(value) >= 1 && Number(value) <= 100_000);
const pairSchema = z.object({
  chainId: z.string(), dexId: z.string(), pairAddress: z.string(),
  baseToken: z.object({ address: z.string(), symbol: z.string().max(80) }),
  priceUsd: decimal.nullish(),
  liquidity: z.object({ usd: z.number().finite().nonnegative().nullish() }).nullish(),
  volume: z.object({ h24: z.number().finite().nonnegative().nullish() }).nullish(),
});
const listSchema = z.object({ tokens: z.array(z.object({
  chainId: z.number(), address: z.string(), decimals: z.number().int().min(0).max(36),
})) });
const routeSchema = z.object({
  code: z.literal(0),
  data: z.object({ routeSummary: z.object({
    tokenIn: z.string(), tokenOut: z.string(), amountIn: z.string().regex(/^[0-9]+$/).max(78),
    amountOut: z.string().regex(/^[0-9]+$/).max(78), gasUsd: decimal.nullish(),
    route: z.array(z.array(z.object({ exchange: z.string().max(80) }))).min(1),
  }) }),
});

export function parseMarketArgs(params: URLSearchParams): ProviderRequestArgs {
  const allowed = new Set(["address", "compareAddress", "positionUsd", "depth"]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) {
      throw new ValidationError(`unsupported or duplicate market parameter: ${key}`);
    }
  }
  const { address } = parseProviderArgs(params);
  let compareAddress: Address | undefined;
  if (params.has("compareAddress")) {
    try { compareAddress = getAddress(params.get("compareAddress")!); }
    catch { throw new ValidationError("invalid compareAddress"); }
    if (compareAddress === address) throw new ValidationError("choose two different tokens");
  }
  const position = positionSchema.safeParse(params.get("positionUsd") ?? "100");
  if (!position.success) throw new ValidationError("positionUsd must be between 1 and 100000, with at most two decimals");
  const rawDepth = params.get("depth");
  if (rawDepth !== null && rawDepth !== "true" && rawDepth !== "false") {
    throw new ValidationError("depth must be true or false");
  }
  return { address, ...(compareAddress ? { compareAddress } : {}),
    positionUsd: formatUnits(parseUnits(position.data, 2), 2), depth: rawDepth === "true" };
}

async function fetchJson(url: string, context: ProviderExecutionContext): Promise<unknown> {
  const response = await context.fetch(url, {
    headers: { accept: "application/json", "x-client-id": "swarm-tab" },
    signal: AbortSignal.timeout(15_000), cache: "no-store", redirect: "error",
  });
  if (!response.ok) throw new Error(`source_http_${response.status}`);
  return response.json();
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}

export async function readMarketToken(address: Address, context: ProviderExecutionContext): Promise<MarketTokenFact> {
  const sourceUrl = `https://api.dexscreener.com/token-pairs/v1/base/${address}`;
  const empty: MarketTokenFact = {
    address, symbol: `${address.slice(0, 6)}…`, status: "unavailable", priceUsd: null,
    liquidityUsd: null, volume24hUsd: null, pairAddress: null, dex: null,
    sourceUrl, observedAt: Date.now(), error: null,
  };
  try {
    const raw = await fetchJson(sourceUrl, context);
    if (!Array.isArray(raw)) throw new Error("invalid_market_response");
    // priceUsd is the BASE token price. Never attribute a quote-token price to
    // the requested token; never sum duplicated pools from different sources.
    const pairs = raw.flatMap((row) => {
      const parsed = pairSchema.safeParse(row);
      return parsed.success && parsed.data.chainId === "base" &&
        parsed.data.baseToken.address.toLowerCase() === address.toLowerCase() &&
        /^0x[0-9a-fA-F]{40,64}$/.test(parsed.data.pairAddress)
        ? [parsed.data] : [];
    }).sort((a, b) => (b.liquidity?.usd ?? -1) - (a.liquidity?.usd ?? -1));
    const best = pairs[0];
    if (!best) return { ...empty, status: "no_market", observedAt: Date.now(), error: "No eligible Base-token market returned by DEX Screener." };
    return {
      ...empty, status: "observed", symbol: best.baseToken.symbol,
      priceUsd: best.priceUsd && Number(best.priceUsd) > 0 ? best.priceUsd : null,
      liquidityUsd: best.liquidity?.usd ?? null, volume24hUsd: best.volume?.h24 ?? null,
      pairAddress: best.pairAddress, dex: best.dexId,
      sourceUrl: `https://dexscreener.com/base/${best.pairAddress}`, observedAt: Date.now(),
    };
  } catch (error) { return { ...empty, observedAt: Date.now(), error: errorText(error) }; }
}

// Exact integer conversion: the USD sizing is a user input, never an LLM
// amount. The model cannot alter token decimals, payee or trade calldata.
export function sizePosition(positionUsd: string, priceUsd: string, decimals: number): bigint {
  if (!positionSchema.safeParse(positionUsd).success || !decimal.safeParse(priceUsd).success ||
      !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new ValidationError("invalid position sizing inputs");
  const [whole, fraction = ""] = priceUsd.split(".");
  if (fraction.length > 36) throw new ValidationError("price precision is unsupported");
  const price = BigInt(whole + fraction.padEnd(36, "0"));
  if (price === 0n) throw new ValidationError("missing positive reference price");
  return (parseUnits(positionUsd, 2) * 10n ** BigInt(decimals) * 10n ** 36n) / (100n * price);
}

async function readTokenDecimals(context: ProviderExecutionContext): Promise<Map<string, number>> {
  // Only token metadata comes from this list; prices and quotes are fetched afresh.
  const data = listSchema.parse(await fetchJson(TOKEN_LIST_URL, context));
  return new Map(data.tokens.filter((token) => token.chainId === 8453)
    .map((token) => [token.address.toLowerCase(), token.decimals]));
}

export async function readExitToken(market: MarketTokenFact, positionUsd: string, decimals: number | null,
  context: ProviderExecutionContext): Promise<ExitTokenFact> {
  const empty: ExitTokenFact = { ...market, routeStatus: "unavailable", decimals,
    sellAmount: null, tokenAmount: null, quotedUsdc: null, gasUsd: null,
    referenceValueUsd: null, quoteGapPct: null, exchanges: [], quoteObservedAt: null,
    quoteSourceUrl: null, quoteError: null };
  if (!market.priceUsd || decimals === null) return { ...empty,
    quoteError: !market.priceUsd ? "No positive token reference price." : "Token decimals are missing from the supported Base metadata list." };
  try {
    const amount = sizePosition(positionUsd, market.priceUsd, decimals);
    if (amount <= 0n) throw new Error("position_below_one_token_unit");
    const url = new URL(QUOTE_URL);
    url.search = new URLSearchParams({ tokenIn: market.address, tokenOut: USDC_BASE,
      amountIn: amount.toString(), gasInclude: "true", excludeRFQSources: "true" }).toString();
    const sized = { ...empty, sellAmount: amount.toString(), tokenAmount: formatUnits(amount, decimals), quoteSourceUrl: url.toString() };
    const raw = await fetchJson(url.toString(), context);
    const parsed = routeSchema.safeParse(raw);
    if (!parsed.success) {
      const code = raw && typeof raw === "object" && "code" in raw ? Number(raw.code) : null;
      const noRoute = code === 4008 || code === 4009;
      return { ...sized, routeStatus: noRoute ? "no_route" : "unavailable", quoteObservedAt: Date.now(),
        quoteError: noRoute ? "Aggregator returned no route." : "No valid quote returned by the aggregator." };
    }
    const quote = parsed.data.data.routeSummary;
    if (quote.tokenIn.toLowerCase() !== market.address.toLowerCase() ||
      quote.tokenOut.toLowerCase() !== USDC_BASE.toLowerCase() || BigInt(quote.amountIn) !== amount) {
      throw new Error("quote_input_mismatch");
    }
    if (BigInt(quote.amountOut) <= 0n || quote.route.every((path) => path.length === 0)) throw new Error("empty_quote_route");
    const price36 = parseUnits(market.priceUsd, 36);
    const ref36 = amount * price36 / 10n ** BigInt(decimals);
    const referenceMicros = ref36 / 10n ** 30n;
    const gapPct = referenceMicros > 0n
      ? Number((referenceMicros - BigInt(quote.amountOut)) * 1_000_000n / referenceMicros) / 10_000 : null;
    return { ...sized, routeStatus: "quoted", quotedUsdc: formatUnits(BigInt(quote.amountOut), 6),
      gasUsd: quote.gasUsd ?? null, referenceValueUsd: formatUnits(ref36, 36), quoteGapPct: gapPct,
      exchanges: [...new Set(quote.route.flatMap((path) => path.map((hop) => hop.exchange)))].slice(0, 8),
      quoteObservedAt: Date.now(), quoteError: null };
  } catch (error) { return { ...empty, quoteObservedAt: Date.now(), quoteError: errorText(error) }; }
}

function requestedAddresses(args: ProviderRequestArgs): Address[] {
  return [args.address, ...(args.compareAddress ? [args.compareAddress] : [])];
}

export async function fetchMarketFacts(args: ProviderRequestArgs, context: ProviderExecutionContext): Promise<ProviderResult> {
  const tokens = await Promise.all(requestedAddresses(args).map((address) => readMarketToken(address, context)));
  return { blockNumber: null, facts: { kind: "market_snapshot", analysisChainId: 8453, blockNumber: null,
    observedAt: Date.now(), tokens, liquidityScope: "Highest reported liquidity pair with the requested token as base token; not total market liquidity." } };
}

export async function fetchExitFacts(args: ProviderRequestArgs, context: ProviderExecutionContext): Promise<ProviderResult> {
  const positionUsd = args.positionUsd ?? "100";
  const sizedUsd = args.depth ? formatUnits(parseUnits(positionUsd, 2) * 10n, 2) : positionUsd;
  const [markets, metadata] = await Promise.all([
    Promise.all(requestedAddresses(args).map((address) => readMarketToken(address, context))),
    readTokenDecimals(context).catch(() => new Map<string, number>()),
  ]);
  // Depth checks above $100,000 are deliberately marked unsupported.
  const tokens = await Promise.all(markets.map((market) => readExitToken(market, sizedUsd,
    metadata.get(market.address.toLowerCase()) ?? null, context)));
  return { blockNumber: null, facts: { kind: "exit_quotes", analysisChainId: 8453, blockNumber: null,
    observedAt: Date.now(), positionUsd: sizedUsd, depth: args.depth ?? false, tokens,
    limitations: ["Indicative routes only; wallet balance, approvals, token transfer restrictions and successful execution are unverified.",
      "Quote gap compares separate source snapshots; it is not measured slippage. Gas is listed separately.",
      "Market data is read from Base mainnet; x402 payments use the application's configured test network."] } };
}
