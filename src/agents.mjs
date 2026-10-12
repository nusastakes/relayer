// The AI staff a mayor can hire (PRD R18/R20, "Bursa Staf AI"). Static metadata plus the live address of each agent; hiring
// is a CityGuardian.grantAgent(city, agent, role, expiry) call by the mayor, and firing is revokeAgent.

import { getAddress, keccak256, toBytes } from "viem";

/** The marker address a mayor grants SATPAM to in order to accept reports from Chainlink CRE (CityGuardian.CRE_SATPAM). */
export const CRE_SATPAM = getAddress(`0x${keccak256(toBytes("city-vault.cre-satpam")).slice(26)}`);

export const ROLES = { SATPAM: 1, ANALIS: 2, HUMAS: 3 };

/** @param {{analyst?: {address: string, info: Function} | null}} relayer  @param {string | null} guardian the CityGuardian address */
export function agentList(relayer, guardian = null) {
  const analyst = relayer.analyst ?? null;
  return {
    guardian,
    hire: "CityGuardian.grantAgent(city, agent, role, expiry) by the mayor; revokeAgent(city, agent) to fire; isActiveAgent(city, agent, role) to check",
    agents: [
      {
        id: "satpam",
        name: "Satpam",
        role: ROLES.SATPAM,
        roleName: "SATPAM",
        address: CRE_SATPAM,
        kind: "chainlink-cre-workflow",
        status: "simulated",
        description: "Watches the city and the source vault; when risk is HIGH it asks the guardian to pull an adapter's money back to idle. Can only evacuate to idle.",
        source: "https://github.com/nusastakes/cre-guardian",
      },
      {
        id: "analis",
        name: "Analis",
        role: ROLES.ANALIS,
        roleName: "ANALIS",
        address: analyst ? analyst.address : null,
        kind: "relayer-bot",
        status: analyst ? "live" : "off",
        llm: analyst ? analyst.info().llmProviders : [],
        description: "Proposes moving idle cash into the yield adapter (or back) with a plain-language reason; nothing moves until the mayor approves.",
        proposals: "GET /proposals/:city",
      },
      {
        id: "humas",
        name: "Humas",
        role: ROLES.HUMAS,
        roleName: "HUMAS",
        address: relayer.humas ? relayer.humas.address : null,
        kind: "report-writer",
        status: relayer.humas ? "live" : "planned",
        llm: relayer.humas ? relayer.humas.info().llmProviders : [],
        description: "Writes the city's weekly report in Indonesian from on-chain events and price snapshots. Read-only: it sends no transactions.",
        reports: "GET /report/:city?days=7",
      },
    ],
  };
}
