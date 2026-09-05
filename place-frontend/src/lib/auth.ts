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
// PIKO's mining site, fixed there and proactively here too, before this
// app has even been deployed). Built from this canister's own id
// (selfCanisterId) rather than a hardcoded literal, since PikoPlace
// hasn't been deployed to mainnet yet and there's no real id to hardcode
// -- see canister-env.ts's own placeholder-avoidance comment for why a
// guessed id would be worse than not having one. Skipped for local dev.
function canonicalOrigin(): string {
  return `https://${selfCanisterId}.icp.net`;
}

// TODO before the real mainnet deploy: this derivationOrigin fix only
// closes half the loop without its matching public/.well-known/
// ii-alternative-origins file (see piko-icp/frontend/public/.well-known/
// for the exact shape) listing this canister's own icp0.io id as
// permitted -- that file needs the real mainnet id too, so it can't be
// created yet either. Add it in the same commit that fills in the real
// mainnet ids in canister-env.ts.

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
