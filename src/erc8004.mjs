// ERC-8004 identity and reputation for the AI staff (PRD R20, R22; backlog BX.4 and BX.6), on Monad testnet.
//
// Each staff agent is an ERC-721 in the Identity Registry whose token URI points at a registration file served by this
// relayer (`GET /agents/:id/card.json`). Other parties rate an agent in the Reputation Registry; the registry refuses
// feedback from the agent's own owner or operators, so ratings must come from a different wallet (a mayor).
//
// The registries are the shared ERC-8004 testnet deployments (the same addresses on every supported testnet). Their
// implementations are not source-verified on Sourcify, so the ABI below comes from the official repository
// (erc-8004/erc-8004-contracts, v2.0.0) and was checked against the live contracts by `scripts/erc8004.mjs status`.

import { readFileSync } from "node:fs";
import { getAddress, parseAbi } from "viem";

export const ERC8004_TESTNET = {
  chainId: 10143,
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
};

export const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function getVersion() pure returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

export const reputationAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function getClients(uint256 agentId) view returns (address[])",
  "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)",
  "function getIdentityRegistry() view returns (address)",
  "function getVersion() pure returns (string)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);

/** Static facts for the registration files. The wallet each agent registers from is in the deployments file. */
export const STAFF = {
  satpam: {
    name: "Nusastakes Satpam",
    description:
      "Security guard for Nusastakes cities: a Chainlink CRE workflow that watches a city and the real Morpho vault its yield mirrors, and, when risk is HIGH, asks CityGuardian to pull an adapter's money back to idle. It can only evacuate to idle and only for cities whose mayor enabled it. Proven so far with `cre workflow simulate --broadcast`, not on the production DON.",
    services: (base) => [
      { name: "web", endpoint: `${base}/agents` },
      { name: "source", endpoint: "https://github.com/nusastakes/cre-guardian" },
    ],
  },
  analis: {
    name: "Nusastakes Analis",
    description:
      "Analyst for Nusastakes cities: proposes moving idle cash into the yield adapter, or back, with a plain-language reason. Amounts come from deterministic rules, the reason from an LLM, and nothing moves until the mayor approves. It can only call CityGuardian.propose.",
    services: (base) => [
      { name: "web", endpoint: `${base}/agents` },
      { name: "proposals", endpoint: `${base}/proposals/{city}` },
    ],
  },
  humas: {
    name: "Nusastakes Humas",
    description:
      "Public-relations writer for Nusastakes cities: writes the city's weekly report in Indonesian from on-chain events and price snapshots. Read-only; it sends no transactions that move money.",
    services: (base, paid = false) => [
      { name: "web", endpoint: `${base}/agents` },
      { name: "report", endpoint: `${base}/report/{city}?days=7` },
      ...(paid ? [{ name: "x402-report", endpoint: `${base}/paid/report/{city}?days=7` }] : []),
    ],
  },
};

/**
 * @param {{publicClient: any, file?: string | null, baseUrl: string, chain?: typeof ERC8004_TESTNET, deployments?: object | null}} options
 * `deployments` (or the JSON `file`) records who registered each agent: { agents: { satpam: { agentId, owner, agentURI, registerTx } } }.
 */
export function createAgentIdentity({ publicClient, file = null, baseUrl, chain = ERC8004_TESTNET, deployments = null, x402Agents = [] }) {
  let saved = deployments;
  if (!saved && file) {
    try {
      saved = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      if (e?.code !== "ENOENT") console.error(`erc8004 file ${file} could not be read (${e?.message}); agents are shown as unregistered`);
    }
  }
  const registered = saved?.agents ?? {};
  const base = baseUrl.replace(/\/+$/, "");
  const agentRegistry = `eip155:${chain.chainId}:${chain.identityRegistry}`;

  return {
    enabled: true,
    registry: { identity: chain.identityRegistry, reputation: chain.reputationRegistry, chainId: chain.chainId, agentRegistry },

    /** The ERC-8004 facts for one staff id, or null if it was never registered. */
    entry(id) {
      const r = registered[id];
      if (!r || r.agentId === undefined) return null;
      return { agentId: String(r.agentId), owner: r.owner ?? null, agentURI: r.agentURI ?? `${base}/agents/${id}/card.json`, registry: agentRegistry };
    },

    /** The registration file of an agent (ERC-8004 "registration-v1"). */
    card(id) {
      const meta = STAFF[id];
      if (!meta) return null;
      const r = registered[id];
      return {
        type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
        name: meta.name,
        description: meta.description,
        services: meta.services(base, x402Agents.includes(id)),
        x402Support: x402Agents.includes(id),
        active: true,
        registrations: r?.agentId === undefined ? [] : [{ agentId: Number(r.agentId), agentRegistry }],
        supportedTrust: ["reputation"],
      };
    },

    /** Average rating over every client that rated the agent, read from the Reputation Registry. */
    async reputation(agentId) {
      const id = BigInt(agentId);
      const clients = await publicClient.readContract({ address: chain.reputationRegistry, abi: reputationAbi, functionName: "getClients", args: [id] });
      if (clients.length === 0) return { count: 0, average: null, clients: 0 };
      const [count, value, decimals] = await publicClient.readContract({ address: chain.reputationRegistry, abi: reputationAbi, functionName: "getSummary", args: [id, clients, "", ""] });
      const average = Number(value) / 10 ** Number(decimals);
      return { count: Number(count), average, clients: clients.length };
    },

    /** Raw feedback rows, newest last, so a UI or a judge can see who rated what. */
    async feedback(agentId, limit = 20) {
      const id = BigInt(agentId);
      const clients = await publicClient.readContract({ address: chain.reputationRegistry, abi: reputationAbi, functionName: "getClients", args: [id] });
      const rows = [];
      for (const client of clients) {
        const last = await publicClient.readContract({ address: chain.reputationRegistry, abi: reputationAbi, functionName: "getLastIndex", args: [id, client] });
        for (let i = last; i >= 1n && rows.length < limit; i--) {
          const [value, decimals, tag1, tag2, isRevoked] = await publicClient.readContract({ address: chain.reputationRegistry, abi: reputationAbi, functionName: "readFeedback", args: [id, client, i] });
          rows.push({ client: getAddress(client), index: Number(i), value: Number(value) / 10 ** Number(decimals), tag1, tag2, revoked: isRevoked });
        }
      }
      return rows;
    },
  };
}
