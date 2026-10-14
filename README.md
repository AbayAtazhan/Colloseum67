# SWARM TAB

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Check your exit. AI agents research within your onchain budget.**

The main product scenario answers: **what would a $100 position in each of two
Base tokens quote into USDC right now?** Market Analyst collects current pair
liquidity and volume. Exit Analyst obtains USD-sized indicative sell routes,
quoted proceeds and gas. The result is two comparison cards with timestamps,
source links and payment evidence. Change the position size in the form.

Market data is read from **Base mainnet** via publicly available DEX Screener,
CoinGecko token metadata and KyberSwap route APIs. The existing x402 settlements
still happen on the configured **test network**. Upstream services receive no
wallet signature or private key. Test USDC pays SWARM TAB's collection and
comparison services; it does not pay DEX Screener or KyberSwap directly.

Two AI agents (DeepSeek) research a task by buying data over x402 HTTP
payments. Every purchase is paid from a single ERC-7710 permission signed once
by the user's MetaMask smart account. The agents share one budget
(`0.05 USDC` by default), each purchase costs `0.02 USDC`, and the contract —
not the server — decides what fits. DeepSeek usage is tracked separately.

```
task ──> Market Analyst (DeepSeek) ─┐
                                   ├─ x402: 402 -> PAYMENT-SIGNATURE -> settle -> data
       Exit Analyst (DeepSeek)──────┘
                                   └─ report with paid sources + refusals
```

## The demonstration scenario

Task: *compare WETH and DEGEN on Base at the selected USD position size*.
Three paid requests of `0.02 USDC` against a `0.05 USDC` budget:

1. Market Analyst buys one snapshot covering both tokens → **settled**;
2. Exit Analyst buys one quote comparison covering both tokens → **settled**;
3. Exit Analyst attempts an optional 10× position depth check → **refused on-chain**
   (`insufficient_funds`, 0.04 + 0.02 > 0.05).

The requested-size comparison remains available after the depth check refusal.
Amounts are sized with integer arithmetic using validated token decimals.
Missing prices, routes or metadata are displayed as **unverified**, never as a
fabricated quote or proof that a token cannot be sold. The visible product
report is assembled from settled provider facts, independently of model prose.

This is a read-only indicative quote comparison. A route preview does not
verify wallet balance, approvals, transfer restrictions, taxes or actual
execution. The displayed quote gap compares separately dated snapshots; it is
not measured slippage. Gas is shown separately. Run a new mission for fresh
quotes. No swap calldata is built or submitted.

The earlier contract-facts scenario is retained in the scenario selector for
payment-core diagnostics and the existing `demo:mission` CLI.

Legacy `npm run demo:mission` output against the local stack (fixture LLM,
clearly labelled; blocks/hashes are real local-chain values):

```
Agents:
  - Code Analyst: completed
    Paid data points received: 2; refusals: 0.
  - Activity Analyst: completed
    Paid data points received: 0; refusals: 1.

Purchases:
  - code 0x1f5e…3d99 0.020000 USDC -> settled block=46 tx=0xd7f6dafcbafaecb4…
  - code 0x425A…5874 0.020000 USDC -> settled block=47 tx=0xc82514a215997699…
  - activity 0x1f5e…3d99 0.020000 USDC -> rejected reason=insufficient_funds

Budget: spent 0.040000 of 0.050000 USDC, remaining 0.010000 USDC
DeepSeek usage: 4 calls, 0 tokens
Sources settled: 2; refusals: 1
```

## Run it on a laptop with one command

```bash
npm install
npm run dev:local
```

`dev:local` boots a local Hardhat EVM, deploys the **real** MetaMask delegation
framework v1.3.0 (DelegationManager, enforcers, Hybrid delegator, EntryPoint),
deploys the custom `MissionPolicyEnforcer` and a 6-decimals test USDC, then
starts Next.js configured for that chain. The UI header shows the actual
network (normally `Local testnet · chain 31337 · http://127.0.0.1:8546`).
Occupied RPC ports are skipped, so use the URL printed by the launcher.
Each new local chain gets a separate SQLite journal (`*.local-<session>.db`);
old journal files are preserved instead of mixing old receipts with new blocks.
Both the RPC node and Next.js bind to `127.0.0.1` for this laptop demo.

In the page:

1. Press **Load exit demo** — fills WETH and DEGEN on Base and a $100 position.
2. **Connect MetaMask** (adds/switches to the local network: RPC
   `http://127.0.0.1:8546`, chain ID `31337`, currency ETH) and
   **Sign permission** with a `0.05 USDC` budget. The server auto-prepares the
   spending account: it deploys the smart account and mints ≥1 test USDC plus
   ETH for prefunds, so the MetaMask wallet itself needs no test funds.
3. The mission starts: two agents attempt three services of `0.02`; two payments
   settle and the third is refused by the contract budget. Spent `0.04`,
   remaining `0.01`, comparison cards with quotes and two paid source receipts.

No MetaMask? Use the clearly labelled **Start server-signed demo** testnet
fallback. No `DEEPSEEK_API_KEY`? The run falls back to a deterministic fixture
LLM only when `SWARM_TAB_FAKE_LLM=1` is explicitly set, labelled everywhere.
Otherwise a missing key is a setup error. With a key in `.env` the same path
runs the real `deepseek-flash` model in non-thinking mode.

Every settled purchase has a **local receipt** (expandable: paymentId, request
hash, response hash, payer, transaction, block) instead of a block-explorer
link, because the chain is local. Press **Run budget test (no LLM)** to prove
the contract cap with three concurrent x402 purchases.

Owner-authorized revocation runs through the browser: **Revoke permission** →
MetaMask signs the packed user operation (the SDK's exact typed-data path) →
the server relayer submits it. The main scenario does **not** need
`USER_OWNER_PRIVATE_KEY` on the server.

CLI reproduction against the running app:

```bash
npm run demo:mission
```

## What is real in this build

- **DeepSeek tool calling**: server-side `POST /chat/completions`, model
  `deepseek-flash`, explicit non-thinking mode
  (`"thinking": {"type": "disabled"}`), `max_tokens: 800`, at most 3 LLM calls
  per agent, timeouts, bounded retries for 429/5xx, and 402/429 handling that
  stops the agent while keeping collected results. Token usage comes from the
  API `usage` field and is stored per call.
- **Product services**: `/api/providers/market` collects current Base markets;
  `/api/providers/exit` sizes the selected position and compares indicative
  token-to-USDC routes. Both cost `0.02` test USDC; one purchase covers both
  supplied addresses. Data has timestamps and analysis chain 8453, never a
  fabricated observation block from the local settlement network.
- **Legacy RPC providers on the server**: `/api/providers/code` (bytecode size,
  keccak hash, prefix, contract presence) and `/api/providers/activity`
  (native balance and transaction count). Both read from RPC at a fixed block,
  validate the address/block inputs, cost exactly `0.02 USDC`, have fixed
  distinct payees, and return facts only — no owner, history or risk claims.
- **x402 v2 over HTTP**: `402` + base64 `PAYMENT-REQUIRED`, client
  `PAYMENT-SIGNATURE` + `X-SWARM-PAYMENT-ID`, facilitator `/verify` and
  `/settle`, `PAYMENT-RESPONSE` on success. Scheme `exact`, asset transfer
  method `erc7710`, `paymentFlow: "upfront"`: the provider settles — and waits
  for the receipt — **before** serving data, so verification alone can never
  leak a paid result.
- **Shared root budget**: the client uses the official MetaMask
  `createx402DelegationProvider` with the mission root as
  `parentPermissionContext`, then explicitly re-decodes the chain and refuses
  to pay if the last delegation hash is not the stored mission root. A new
  child is created per request; the root `ERC20TransferAmountEnforcer` spend is
  the source of truth and is never reset.
- **Local facilitator/relayer**: verifies by simulating `redeemDelegations`
  with the relayer as caller, then broadcasts it and waits for confirmation.
  The relayer queue hands out consecutive nonces so concurrent settlements can
  not collide; budget refusals surface as `insufficient_funds`.
- **Idempotency**: every purchase carries a unique `paymentId` bound to its
  mission and a keccak hash of the canonical request. A repeat within that
  mission with the same id and request
  returns the stored result and the original transaction (`x-swarm-idempotent:
  true`); a repeat with a different mission or request is `409 payment_id_conflict`; a
  refusal stays a refusal and is never marked as paid.
- **Journal and receipts** (SQLite): `missionId`, agent, `paymentId`,
  provider, request hash, response hash, amount, state, error kind/reason,
  transaction hash and block number, plus the cached paid result. On-chain
  spend is read from the enforcer and reconciled with local receipts.
- **UI**: one dark, responsive screen with wallet connect + permission signing
  for the configured chain, local demo mode, Start mission, Revoke permission
  (also available after completion), two agent
  cards, shared spent/remaining, purchase journal with expandable receipts,
  report with linked sources, transaction links, and a separate clearly
  labelled **contract budget test (no LLM)**.

## Contract-path stress test (no LLM)

The budget proof is deliberately independent of the model. `POST
/api/missions/stress` (button *Run budget test*) creates a fresh mission and
fires three concurrent x402 purchases of `0.02` against `0.05`. Actual HTTP
result from the running app:

```json
{
  "requests": 3,
  "settled": 2,
  "rejected": 1,
  "failed": 0,
  "onchainSpent": "40000",
  "budget": "50000",
  "results": [
    { "state": "settled", "txHash": "0x42f959882e1c0b898aeab9cd0e3fcd37…" },
    { "state": "settled", "txHash": "0xa9c3a7e16018d0dd88bf95d9666da701…" },
    { "state": "rejected", "reason": "insufficient_funds: settlement failed" }
  ]
}
```

The same scenario is covered by `tests/integration/x402-stress.test.ts`.

## HTTP 402 challenge (actual decoded header)

```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6Miwi…          # base64 PaymentRequired
```

```json
{
  "scheme": "exact",
  "network": "eip155:31337",
  "amount": "20000",
  "asset": "0x1f5e0dD43f421b7580914027d2D3c646367C3D99",
  "payTo": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "maxTimeoutSeconds": 120,
  "extra": {
    "assetTransferMethod": "erc7710",
    "paymentFlow": "upfront",
    "name": "USDC",
    "version": "2",
    "facilitatorAddresses": ["0x976EA74026E726554dB657fA54763abd0C3a0aa9"],
    "providerId": "code"
  }
}
```

## Budget enforcement (unchanged from the payment core)

| Role | Type | Why |
| --- | --- | --- |
| User | EOA + MetaMask Hybrid smart account | Holds USDC; signs the single root permission (browser MetaMask on Base Sepolia, or a generated test owner for CI runs) |
| Executor | EOA | Creates one-shot child delegations per request; needs no ETH and cannot mint budgets |
| Relayer/facilitator | EOA | Redeems the ERC-7710 chain, pays settlement gas, queues nonces |
| Deployer | EOA | Pays one-time deployments (MissionPolicyEnforcer, the user's smart account); never touches mission funds |

Root caveats: cumulative `ERC20TransferAmountEnforcer(USDC, 50000)`,
`TimestampEnforcer` (anchored to the chain's block time), `RedeemerEnforcer`,
and the custom `MissionPolicyEnforcer` (recipient allow-list + per-call cap).
Each x402 child adds its own one-shot scope, `LimitedCalls(1)`,
`AllowedTargets`/`AllowedMethods`, payee `AllowedCalldata` and expiry.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev:local` | **one-command laptop run**: local chain + contract deployment + Next.js |
| `npm run demo:mission` | CLI: create mission → two agents → paid x402 → report (needs the app running) |
| `npm run base:mission` | Base Sepolia live run: signs with the server-side test owner (never the user's MetaMask key), starts the DeepSeek mission and prints BaseScan links |
| `npm run deepseek:check` | one real DeepSeek request + one tool-call round trip (when a key is present) |
| `npm run dev` | Next.js only (expects an existing environment/config) |
| `npm test` | contracts compile + unit + integration (61 tests) |
| `npm run test:unit` | fast unit tests (DeepSeek client, x402 wire types, policy, store) |
| `npm run test:integration` | contract-path tests on a local EVM |
| `npm run demo:budget` | stage-1 shared-budget demo (direct `PaymentService`) |
| `npm run chain:check` | verify RPC, official USDC, framework/custom enforcer code, balances |
| `npm run network:prepare` | Base Sepolia checklist and smart-account deployment |
| `npm run contracts:deploy-enforcer` | deploy `MissionPolicyEnforcer` with the deployer key |
| `docs/DEMO.md` | the 3-minute demo script and fallbacks |
| `docs/PITCH.md` | short English pitch text |

## Tests (actual result)

```
Test Files  15 passed (15)
Tests       61 passed (61)
```

Groups: integer USDC amounts; store state machine + purchases/LLM/report;
delegation caveats and attenuation; DeepSeek non-thinking body, tool calls,
402/429/timeout handling; x402 requirements/validation/idempotency hashing;
official MetaMask x402 helper reuses the mission root; full x402 flow on real
contracts (settle + receipt + idempotent replay + third refusal); concurrent
stress; owner-authorized revocation via the browser userOp path (revoke after
a settled payment, next payment refused by the revoked permission, tampered
call and foreign signature rejected); local auto-funding; the original stage-1
budget guards. Regression coverage includes HTTP-shaped wallet submission,
cross-mission receipt replay, cached observed-block consistency, forged payer
and network metadata, failed inner EntryPoint operations, occupied RPC ports,
DeepSeek transport retry limits and response-body timeouts.

Wallet tests sign the exact HTTP JSON using MetaMask's `eth-sig-util` v4
encoder, then register and spend the permission on real local contracts.
The same encoder signs revocation. Both payloads explicitly declare
`types.EIP712Domain`; raw `eth_signTypedData_v4` does not infer domain fields
as viem's signing helper does. Wrong-chain/verifier signatures are rejected.

Report source blocks refer to the RPC observation; receipt settlement blocks
are shown separately. These can differ because payment is mined after observation.

## Configuration

Copy `.env.example` to `.env`. Secrets stay local (`.env*` is gitignored).
Server-side only: `DEEPSEEK_API_KEY`, `USER_OWNER_PRIVATE_KEY`,
`EXECUTOR_PRIVATE_KEY`, `RELAYER_PRIVATE_KEY`, `DEPLOYER_PRIVATE_KEY`. The
browser only receives public parameters (addresses, chain id, token metadata,
spend, journal). `RELAYER_PRIVATE_KEY` and `DEPLOYER_PRIVATE_KEY` fall back to
the executor key when unset, but separate keys are recommended: the relayer
needs test ETH for settlements, the deployer needs test ETH for one-time
deployments, and the executor needs no ETH at all.

DeepSeek setup: `DEEPSEEK_API_KEY` in `.env`, then `npm run deepseek:check`.
Without it the app shows a setup state, and local demos must run in the
explicitly labelled fixture mode (`SWARM_TAB_FAKE_LLM=1`, set automatically by
`dev:local` when no key is present). Fixtures are never presented as live runs:
`fixture` is stored on every LLM call and shown in the UI.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Page renders but buttons do nothing / addresses stay empty | Next.js dev blocks cross-origin dev resources for `127.0.0.1`; `next.config.ts` already allows it. If you see it after editing the config, restart `npm run dev:local`. |
| Port already in use | `PORT=3001 npm run dev:local` and open the printed URL. |
| MetaMask shows the wrong chain or stuck nonce | Switch to chain ID `31337` (the UI offers to add the network), then MetaMask → Settings → Advanced → Clear activity tab data. |
| MetaMask asks for funds | It should not: the server auto-funds the spending smart account (≥1 USDC + ETH for prefunds). If it does, you are on a different network. |
| Revoke says "Connect 0x… in MetaMask" | The connected account is not the mission owner. Connect the owner wallet, or use the server-signed local demo whose revocation falls back to the testnet owner. |
| Owner signature invalid after updating the code | Hard-refresh the page, reconnect MetaMask and sign a fresh permission; old payloads without `types.EIP712Domain` cannot be reused. |
| DeepSeek key missing or rate-limited | The UI shows a setup state / fixture label, and a failing mission stops with a partial report. Run `npm run deepseek:check` to verify the key. |
| Demo shows an old mission | Start a new mission. Restarting `dev:local` automatically creates a fresh journal alongside the preserved old files. |
| `npm test` cannot start the local chain | The harness skips occupied ports 8546–8565 and stops only its own node. Check that a free port exists; Hardhat build-info watching uses polling to avoid native watcher limits. |
| Where are the transaction links? | The chain is local, so receipts expand inline with tx hash, block, paymentId and hashes; BaseScan links appear only on Base Sepolia. |

## Roadmap: Base Sepolia and hosting

The hackathon MVP runs on the local testnet. Base Sepolia configuration and
scripts exist, but a funded end-to-end deployment has not been verified.
The framework deployment addresses configured by the app (v1.3.0) are:

| Contract | Address |
| --- | --- |
| DelegationManager | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` |
| HybridDeleGatorImpl | `0x48dBe696A4D990079e039489bA2053B36E8FFEC4` |
| SimpleFactory | `0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c` |
| ERC20TransferAmountEnforcer | `0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc` |
| TimestampEnforcer | `0x1046bb45C8d673d4ea75321280DB34899413c069` |
| LimitedCallsEnforcer | `0x04658B29F6b82ed55274221a06Fc97D318E25416` |
| RedeemerEnforcer | `0xE144b0b2618071B4E56f746313528a669c7E65c5` |
| USDC (Circle test token) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Base Sepolia needs funded test keys (deployer and relayer ETH, spending
account USDC). `network:prepare` prints the generated addresses and the exact
missing amounts; once funded:

1. `npm run contracts:deploy-enforcer` (deployer ETH) and set
   `MISSION_POLICY_ENFORCER_ADDRESS`;
2. fund the spending smart account with ≥ 0.05 USDC
   (faucet.circle.com, Base Sepolia);
3. `npm run network:prepare` → `npm run chain:check`;
4. `npm run dev` and `npm run base:mission` (or sign with MetaMask in the UI).

The same scenario is verified through the browser on the local contract path
with the **live** DeepSeek model: 2 settled payments of 0.02, the third refused
on-chain (`insufficient_funds`, 0.04 + 0.02 > 0.05) while the spending account
held 9.96 USDC, 4 live LLM calls / 4360 tokens, 0 fixture calls. The UI also
proves the contract cap with three concurrent purchases (2 settled, 1 rejected,
on-chain spent exactly 40000) and owner-authorized revocation: after Revoke the
mission shows `revoked` with its transaction, and the next payment is refused
with `invalid_transaction_state` even though 0.05 budget remains.

## Explicit limitations

- The live DeepSeek run in this workspace was executed on the **local contract
  path** (real model, real x402 handshake, local chain); Base Sepolia remains a
  funded-deployment step (`network:prepare` lists the exact amounts).
- The local facilitator is part of the app. Pointing x402 at an external
  facilitator requires an ERC-7710-compatible service and interoperability
  testing; only the app's own relayer is exercised here.
- Browser revocation uses the MetaMask `eth_signTypedData_v4` user-operation
  path and is covered by integration tests using MetaMask's v4 encoder;
  approving it in a real MetaMask window is a user action.
- The mission runner lives in the server process: restarting the server
  interrupts an active run (the journal and receipts stay in SQLite).
- The providers only accept permission chains whose root is a mission
  registered in this app (`unknown_mission` otherwise).
- The two LLM agents run sequentially for a predictable demo; the separate
  budget test proves concurrent payment enforcement. The providers expose
  basic RPC facts, not security audits or valuable proprietary datasets.
- Public hosting requires API authentication/rate limits, durable job workers,
  and reconciliation of transactions whose receipt wait times out. The local
  instant-mining demo does not validate those production concerns.
## Standalone web deployment

See [docs/HOSTING.md](docs/HOSTING.md) for the Free Render blueprint, cloud startup and verification. This runs without the laptop, uses a separate demo chain (31338), and protects DeepSeek calls with a demo password. Free-server restarts reset demo chain/history; it is not a durable production deployment.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.


