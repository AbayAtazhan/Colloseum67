import type { ExitCheckReport } from "@/shared/exit-check";

function dollars(value: string | number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return "Not available";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits }).format(Number(value));
}
const observedAt = (value: number | null | undefined) => value ? new Date(value).toLocaleTimeString() : "Not observed";

export function ExitCheck({ report }: { report: ExitCheckReport }) {
  return (
    <section className="rounded-xl border border-emerald-900 bg-emerald-950/10 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">Can you exit a {dollars(report.positionUsd)} position?</h2>
        <span className="rounded-full border border-sky-900 px-3 py-1 text-xs text-sky-300">Base mainnet data · indicative quotes</span>
      </div>
      <p className="mt-2 text-sm text-zinc-300">{report.conclusion}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {report.tokens.map((token) => {
          const market = token.market ?? token.exit;
          const exit = token.exit;
          const quoted = exit?.routeStatus === "quoted";
          const metrics = [
            ["Reference token price", dollars(exit?.priceUsd ?? market?.priceUsd, 8)],
            ["Highest reported pair liquidity", dollars(market?.liquidityUsd, 0)],
            ["Pair volume · 24h", dollars(market?.volume24hUsd, 0)],
            ["Token amount quoted", exit?.tokenAmount ?? "Not sized"],
            ["Estimated gas", dollars(exit?.gasUsd, 4)],
            ["Quote gap vs reference", exit?.quoteGapPct != null ? `${exit.quoteGapPct.toFixed(3)}%` : "Not available"],
            ["Quoted route", exit?.exchanges.join(" · ") || "Not verified"],
          ];
          return (
            <article key={token.address} className="rounded-xl border border-zinc-700 bg-zinc-950 p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-lg font-medium">{market?.symbol ?? "Token"}</h3>
                <span className={`rounded border px-2 py-1 text-xs ${quoted ? "border-emerald-800 text-emerald-300" : "border-amber-800 text-amber-300"}`}>
                  {quoted ? "Route found" : "Exit unverified"}
                </span>
              </div>
              <p className="mt-1 break-all font-mono text-[10px] text-zinc-500">{token.address}</p>
              <p className="mt-4 text-xs uppercase tracking-wide text-zinc-400">Quoted proceeds before gas</p>
              <p className="mt-1 text-3xl font-semibold tracking-tight">{quoted ? `${Number(exit.quotedUsdc).toFixed(4)} USDC` : "Not verified"}</p>
              <p className="mt-1 text-xs text-zinc-500">{quoted ? "Execution has not been tested" : exit?.quoteError ?? market?.error ?? "No paid quote was received"}</p>
              <dl className="mt-4 space-y-2 text-xs">{metrics.map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3"><dt className="text-zinc-400">{label}</dt><dd className="max-w-[58%] break-all text-right">{value}</dd></div>
              ))}</dl>
              <p className="mt-3 text-[11px] text-zinc-500">Market snapshot {observedAt(market?.observedAt)} · Quote snapshot {observedAt(exit?.quoteObservedAt)}</p>
              <div className="mt-2 flex flex-wrap gap-3 text-xs">
                {market && <a className="text-sky-400 underline" href={market.sourceUrl} target="_blank" rel="noreferrer">Market source</a>}
                {exit?.quoteSourceUrl && <a className="text-sky-400 underline" href={exit.quoteSourceUrl} target="_blank" rel="noreferrer">Quote source</a>}
              </div>
            </article>
          );
        })}
      </div>
      <p className="mt-4 rounded-lg border border-amber-900 bg-amber-950/20 p-3 text-sm text-amber-200">
        {report.depthCheck === "budget_blocked"
          ? "The optional 10× depth check was blocked by your shared contract budget. The requested-size quotes above remain available."
          : report.depthCheck === "completed" ? "The optional 10× check was purchased. Open its receipt to inspect the depth data."
          : "The optional 10× depth check has not been verified."}
      </p>
      <details className="mt-3 text-xs text-zinc-400"><summary className="cursor-pointer">What this check covers</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">{report.limitations.map((text) => <li key={text}>{text}</li>)}</ul>
      </details>
    </section>
  );
}
