import { getCanisterEnv } from "@icp-sdk/core/agent/canister-env";

interface CanisterEnv {
  readonly "PUBLIC_CANISTER_ID:place": string;
  readonly "PUBLIC_CANISTER_ID:place-frontend": string;
  readonly "PUBLIC_CANISTER_ID:test-ledger": string;
}

export const canisterEnv = getCanisterEnv<CanisterEnv>();

export const placeCanisterId = canisterEnv["PUBLIC_CANISTER_ID:place"];
// This canister's own id -- every canister sees its own PUBLIC_CANISTER_ID
// entry, not just siblings'. Used by auth.ts to pin Internet Identity
// derivation to this exact origin regardless of which real domain
// (icp.net vs icp0.io) served the page -- see that file's own comment.
export const selfCanisterId = canisterEnv["PUBLIC_CANISTER_ID:place-frontend"];
export const rootKey = canisterEnv.IC_ROOT_KEY;

// Only the local gateway serves from a *.localhost host, so that's enough
// to tell local dev apart from mainnet.
const isLocal = window.location.hostname.endsWith("localhost");

// The real, live PIKO ledger on mainnet -- place itself defaults to this
// same id (see place/src/main.mo's pikoLedgerId) and only ever gets
// redirected to a local test-ledger for local development.
const REAL_PIKO_LEDGER_CANISTER_ID = "56aad-fiaaa-aaaaj-qsefa-cai";
export const ledgerCanisterId = isLocal
  ? canisterEnv["PUBLIC_CANISTER_ID:test-ledger"]
  : REAL_PIKO_LEDGER_CANISTER_ID;

// PikoPlace is live on mainnet (deployed 2026-09-05). place/place-frontend
// canister ids are never hardcoded here, unlike REAL_PIKO_LEDGER_CANISTER_ID
// above -- both come from getCanisterEnv()'s auto-injection instead (see
// placeCanisterId/selfCanisterId), so there was never a placeholder-id risk
// here the way PikoPoker's own canister-env.ts history once had.
