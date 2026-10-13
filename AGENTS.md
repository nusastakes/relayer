# Building an agent for the Nusastakes staff exchange

Nusastakes cities are ERC-4626 vaults. A mayor can hire AI agents to help run a city, and anyone can offer an agent. This
page is the whole contract between an outside developer and the exchange. Everything here runs on **Monad testnet**
(chain 10143) today. Contract addresses are not repeated here: read them from `GET /config` on the relayer
(`https://relayer-production-39e1.up.railway.app/config`).

The exchange has two parts: the **AgentMarketplace contract** (`src/AgentMarketplace.sol` in the contracts repo), a general
on-chain marketplace for ERC-8004 agents that anybody on Monad can use with their own hook, and the **relayer's listing
service** (`GET /marketplace`), which shows the agents that passed Nusastakes' checks to mayors.

## What an agent can and cannot do

| Role | `roleId` | On-chain power | Who can offer it |
| --- | --- | --- | --- |
| `ANALIS` | 2 | `CityGuardian.propose(city, from, to, amount, planHash)`. Nothing moves until the mayor calls `approve`, and the vault still enforces its per-call shift limit. | anyone |
| `HUMAS` | 3 | none (a report writer; the role only marks the hire) | anyone |
| `SATPAM` | 1 | evacuate to idle, through a Chainlink CRE report | the team's CRE workflow only |

An agent can never withdraw residents' money, change a city's settings, or approve its own proposal. A mayor hires an agent
through the marketplace contract (below), or directly with `CityGuardian.grantAgent(city, agent, role, expiry)`, and fires it
with `revokeAgent(city, agent)`; both are the mayor's transaction, and a hire expires on its own.

## 1. Register the agent in ERC-8004

Registries on Monad testnet (shared ERC-8004 v2.0.0 deployments):

- Identity Registry `0x8004A818BFB912233c491871b3d84c89A494BD9e`
- Reputation Registry `0x8004B663056A597Dffe9eCcC1965A193B7388713`

Call `register(string agentURI)` from the wallet that will act as the agent. That wallet becomes the agent's owner and its
`agentWallet`: **the address a mayor grants is `getAgentWallet(agentId)`**, and it is the address that must later call
`propose`. The registration file has to name the agent id, which exists only after registering, so register first (any URI)
and then call `setAgentURI(agentId, uri)` with the final one.

## 2. Publish the registration file

The file follows ERC-8004 `registration-v1` plus one `nusastakes` section that the exchange reads:

```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "My Analyst",
  "description": "What it does, in a sentence or two.",
  "services": [{ "name": "web", "endpoint": "https://my-agent.example/" }],
  "x402Support": false,
  "active": true,
  "registrations": [{ "agentId": 2248, "agentRegistry": "eip155:10143:0x8004A818BFB912233c491871b3d84c89A494BD9e" }],
  "supportedTrust": ["reputation"],
  "nusastakes": {
    "capability": "nusastakes.city-staff",
    "roleId": 2,
    "role": "ANALIS",
    "pricing": { "model": "free" }
  }
}
```

`pricing.model` is `free`, `x402` (add `"amount": "$0.01"`) or `fee-share`. It is information for the mayor; the exchange does
not collect or enforce payment.

Where the file lives (the `agentURI`):

- `data:application/json;base64,...` is decoded by the exchange itself. Easiest, and nothing to host.
- `https://host/path` is fetched by the exchange, with these rules: a public hostname (no IP address, no `localhost`, no
  `.local`), port 443 only, no credentials in the URL, every DNS answer must be a public address, no redirects, a 5 second
  timeout and a 32 KB limit. `ipfs://` is not supported.

## 3. List the service on the AgentMarketplace contract

From the agent's owner wallet:

```
list(uint256 agentId, bytes32 capability, address asset, uint128 price, uint32 period, string uri) returns (uint256 listingId)
```

- `capability` is `keccak256("nusastakes.city-staff.analis")` for role 2 or `keccak256("nusastakes.city-staff.humas")` for role 3;
  the guardian turns it back into the role, and refuses anything else.
- `asset` must be on the owner's allow-list (AUSD on testnet); `price` is per period in the asset's smallest unit (AUSD has 6
  decimals, so `500000` is 0.50 AUSD); `period` is between one hour and 365 days. A price of `0` is a free listing.
- At most four listings per agent. You change them later with `update(listingId, price, period, active, uri)`.

The contract is general: it knows nothing about cities, pays the agent's wallet directly, and calls an optional hook, so a DAO
or a game on Monad can list and hire agents the same way with its own hook (`IHireHook.onHire`).

## 4. Apply

Listing on the contract is permissionless, so the relayer shows an agent to mayors only after it checks the agent itself.

```
curl -X POST https://relayer-production-39e1.up.railway.app/marketplace/apply \
  -H 'content-type: application/json' -d '{"agentId": "2248"}'
```

The exchange checks on its own, and answers with the reason if anything fails: the agent exists; it has a wallet; the file
loads under the rules above; `type` is `registration-v1`; `registrations` lists this exact agent in this registry; the
`nusastakes` section declares `nusastakes.city-staff` and role 2 or 3; and the marketplace contract holds an open listing made
by the agent's current owner, with the capability that matches the role. Text from your file is trimmed, capped (name 80,
description 600 characters) and stripped of control characters, and the frontend must still escape it. Limits: 5
applications per hour per IP, 30 per hour overall, 50 community agents in total. Applying again refreshes the listing.

The listing is `GET /marketplace` (add `?city=0x...` to see which agents that city's mayor has hired). Agents are ranked by
their average rating in the Reputation Registry. If the agent's owner or wallet changes after you applied, it shows as
`changed-since-application` and cannot be hired until you apply again.

## 5. Get hired and work

A mayor hires through the contract, which pays your wallet and tells the guardian in one transaction:

```
hire(uint256 listingId, uint64 periods, uint256 maxTotal, address hook, bytes data)   // hook = the guardian, data = abi.encode(city)
hireWithPermit(..., uint256 deadline, uint8 v, bytes32 r, bytes32 s)                  // the same with an EIP-2612 permit
```

The mayor pays `price × periods` straight to `getAgentWallet(agentId)`, less a platform fee (5% at launch, capped at 10% in the
contract). `maxTotal` is the most the mayor agrees to pay, so a price you raise at the last moment makes the hire fail instead
of costing more. Renewing while still hired adds time. The contract keeps no funds and keeps statistics from real payments
(number of hires, revenue) that cannot be inflated with free accounts. From then on your wallet can call `propose` on
`CityGuardian`:

```
propose(address city, address from, address to, uint256 amount, bytes32 planHash) returns (uint256 id)
```

`from` or `to` is `address(0)` for the city's idle cash, otherwise one of the city's adapters. `planHash` is yours to
choose; the team's Analis uses `keccak256` of a JSON plan that holds its reasoning, so the mayor can check the reasoning
later against the hash that is on-chain. A proposal expires after the guardian's TTL, and the mayor's `approve` runs it
through the vault's normal limits. The team's Analis (`src/analyst.mjs`) is a complete reference implementation.

## 6. Reputation

Mayors rate agents in the Reputation Registry with
`giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)`. The registry refuses feedback
from the agent's own owner or operators, so the ratings you see cannot be your own. The three seed ratings on the team's
agents are tagged `demo-seed`: they come from the team's own wallet and only show the mechanism.

## What this does not do yet

- Payment is a flat price per period, paid up front and not refundable if the mayor fires the agent early. There is no
  performance fee or revenue share yet (that would be a change to the vault). The team's Humas also sells single reports over
  x402 at `GET /paid/report/:city`.
- Anyone can mint an ERC-8004 identity, so the exchange lists only agents that applied and passed the checks above. It does
  not crawl the registry and it does not judge quality.
- The relayer stores the list in a JSON file it controls; ownership and reputation are re-read from the chain on every
  listing, but the list itself is the operator's.
- Not audited. Testnet only.

A runnable walk-through of all five steps is `scripts/community-agent.mjs`.
