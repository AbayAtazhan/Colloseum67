# SWARM TAB — pitch (English)

**Can your AI research a trade without emptying its wallet?**

Before entering a position, traders need to understand its exit: available
liquidity, a route back to USDC and the proceeds quoted for their position
size. SWARM TAB delegates this research to two AI agents with one contract
enforced spending allowance.

SWARM TAB moves the spending limit into a contract. The user's MetaMask smart
account signs a single ERC-7710 permission: a 0.05 USDC mission budget, a 0.02
USDC per-call cap, two allowed payees, an expiry window, and a revocable root.
The server executor can create one-shot child permissions under that root, but
it can never mint a new budget. Every x402 purchase is a real HTTP 402
handshake whose settlement is an on-chain delegation redemption — two agents
share one budget, and the contract rejects the third 0.02 purchase because
0.04 + 0.02 exceeds 0.05.

In the live demo, Market Analyst buys a comparison of two Base tokens from
our market service. Exit Analyst buys indicative, USD-sized sell routes from
our quote service. The screen shows liquidity, quoted USDC proceeds, gas,
timestamps and source links. An optional 10x size check hits the shared
contract budget: two purchases settle, the third is refused, and the useful
requested-size results remain available. The owner can revoke the permission
through MetaMask.

The product cards are computed from paid provider facts, independently of
model prose. Data comes from Base mainnet; x402 payments run on a local
testnet using the real MetaMask Delegation Framework and relayer. Upstream
market APIs are publicly available: the prototype charges test USDC for our
collection, sizing and comparison service. Indicative routes are dated
previews; successful execution, token safety and wallet permissions have not
been verified. No trade is executed.

The next product step is connecting independent specialist data sellers and
checking fresh execution conditions while preserving the same spending
permission. Public deployment remains future work.

The model decides what to buy. The contract decides what can be spent.
