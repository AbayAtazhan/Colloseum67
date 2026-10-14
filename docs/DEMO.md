# SWARM TAB — 3-minute demo script

**Positioning:** two AI agents check the exit from a position, buying market
and quote comparisons through x402 under one contract enforced allowance.

## Before the demo (do once, ~2 minutes)

1. `.env` contains `DEEPSEEK_API_KEY` (server-side only) and
   `SWARM_TAB_NETWORK=local` is set by the launcher.
2. `npm run dev:local` is running; it boots:
   - a local Hardhat chain (normally `http://127.0.0.1:8546`, chain ID 31337;
     use the actual printed port),
   - the real MetaMask Delegation Framework v1.3.0 + the custom
     `MissionPolicyEnforcer`,
   - a 6-decimals test USDC and a spending smart account funded above budget.
3. The browser is open at the printed URL (`http://127.0.0.1:3000`).
4. Test MetaMask in a normal browser before recording: add network
   **SWARM TAB Local testnet**, RPC from the UI header, chain ID `31337`,
   currency ETH. The server
   auto-funds the user smart account (≥1 USDC + ETH for prefunds), so the
   MetaMask wallet itself never needs test funds.

If anything is off: `npm run chain:check` is not needed locally; re-run
`npm run dev:local`. Fallback if MetaMask is not available: use **Start
server-signed demo** (labelled testnet fallback).

## The script

**0:00 — Hook (15s)**
> "What would a $100 position in these tokens quote back into USDC? Two AI
> agents research the exit. You control their spending with one permission."

**0:15 — One command (15s)**
Show the terminal: `npm run dev:local`. Point at the UI header:
`Local testnet · chain 31337 · http://127.0.0.1:8546`, badge
`Local testnet · Test USDC`, `DeepSeek live · deepseek-flash`.
Press **Load exit demo**: WETH and DEGEN addresses on Base. Position size is
$100 per token. Point out that Base mainnet data and local test payments are
separate. No trade is submitted and the quote is an indicative preview.

**0:30 — Permission (30s)**
Budget stays `0.05`. Click **Connect MetaMask** → **Sign permission**.
Explain: the wallet signs one ERC-7710 root permission (budget, per-call cap
0.02, two payees, expiry, revoke). The owner key never leaves MetaMask; the
executor and relayer keys cannot create budgets. The UI shows the smart
account balance above the budget, proving the wallet is not empty.

**1:00 — Agents run (60s)**
The mission auto-starts after signing. The two agents run sequentially:
- Market Analyst buys one normalized snapshot for both tokens (0.02).
- Exit Analyst buys one comparison of USD-sized USDC sell routes (0.02).
- Exit Analyst's optional 10x size check is refused by the contract (0.02
  would exceed the remaining 0.01).
Point at the journal: two green `settled` rows with block numbers and local
receipts, one red `rejected` row with the reason.

**2:00 — Report and proof (30s)**
Spent `0.04`, remaining `0.01`. Show the two token cards: reported pair
liquidity, quoted proceeds in USDC, estimated gas, route sources and dated
snapshots. Quote gap is a comparison of separate source snapshots, not
measured slippage. Missing data stays unverified. Open a receipt: paymentId,
request hash, response hash and local settlement transaction. Mainnet data
has timestamps; the local receipt block proves only the payment. The account
still has funds; the refusal is the contract allowance (0.04 + 0.02 > 0.05).

**2:30 — Revocation (optional, 20s)**
Even after completion, click **Revoke permission** → sign in MetaMask. The card shows
*Waiting for wallet signature… → Confirming on-chain… → revoked*. Optional
line: "a revoked budget cannot be spent, even if the agents still have
remaining funds."

**2:50 — Contract test (10s)**
Press **Run budget test (no LLM)**: 3 concurrent purchases, 2 settled,
1 rejected, on-chain spent exactly `40000`. Closing line:

> "The model decides what to buy; the contract decides what can be spent."

## Fallbacks

| Problem | Fallback |
| --- | --- |
| MetaMask not installed / not configured | **Start server-signed demo** (clearly labelled testnet fallback) |
| DeepSeek slow or rate-limited | The mission stops with a partial report; show the journal and re-run. Or run **Run budget test (no LLM)** to prove the contract path |
| Market / quote API unavailable | Show the explicit unverified state; do not invent results. The legacy Contract facts scenario in the selector can demonstrate the payment core without external market sources |
| Port busy | `PORT=3001 npm run dev:local`, open the printed URL |
| Old state in the UI | Create a new mission; restarting the local chain creates a fresh journal while preserving old files |
