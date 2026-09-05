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

// PikoPlace has not been deployed to mainnet yet (built and verified on
// the local network only, see ../../scripts/deploy-local.sh). Deliberately
// no hardcoded mainnet place/place-frontend canister id here -- see
// PikoPoker's own canister-env.ts history for why: it once shipped with a
// placeholder id that was never actually its real mainnet id, and that
// went unnoticed until someone checked. Whoever does the real mainnet
// deploy must fill in the real ids here deliberately, not copy a guess.
