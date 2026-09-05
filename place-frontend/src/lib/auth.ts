import { AuthClient } from "@icp-sdk/auth/client";
import { selfCanisterId } from "./canister-env";

// Defaults to the current Internet Identity frontend (id.ai) already.
const MAX_TTL_NANOSECONDS = BigInt(8 * 60 * 60) * BigInt(1_000_000_000); // 8h

// Every IC canister is reachable from at least two real, distinct origins
// -- <id>.icp.net and <id>.icp0.io (a standard boundary-node domain, works
// identically, never advertised but real). Internet Identity derives a
// different principal per origin by design, so the same II anchor would
// produce two different principals for this same site depending purely on
// which domain happened to be open -- see piko-icp/frontend/src/lib/
// auth.ts's own comment for the full story (a real user-reported bug on
// PIKO's mining site, fixed there and proactively here too). Built from
// this canister's own id (selfCanisterId, auto-resolved via
// getCanisterEnv per environment) rather than a hardcoded literal.
// Skipped for local dev. The matching public/.well-known/
// ii-alternative-origins file (listing this canister's own icp0.io id as
// a permitted alternative origin) was added in the same mainnet-deploy
// commit as this comment update.
function canonicalOrigin(): string {
  return `https://${selfCanisterId}.icp.net`;
}

let authClientPromise: Promise<AuthClient> | null = null;

function getAuthClient(): Promise<AuthClient> {
  if (!authClientPromise) {
    authClientPromise = Promise.resolve(new AuthClient());
  }
  return authClientPromise;
}

export async function login() {
  const client = await getAuthClient();
  const isLocal = window.location.hostname.endsWith("localhost");
  return client.signIn({
    maxTimeToLive: MAX_TTL_NANOSECONDS,
    ...(isLocal ? {} : { derivationOrigin: canonicalOrigin() }),
  });
}

export async function logout() {
  const client = await getAuthClient();
  await client.signOut();
}

export async function getStoredIdentity() {
  const client = await getAuthClient();
  return client.isAuthenticated() ? client.getIdentity() : null;
}
