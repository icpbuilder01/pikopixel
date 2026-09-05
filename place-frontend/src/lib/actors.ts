import type { Identity } from "@icp-sdk/core/agent";
import { createActor as createLedgerActor } from "../bindings/ledger/ledger";
import { createActor as createPlaceActor } from "../bindings/place/place";
import { placeCanisterId, ledgerCanisterId, rootKey } from "./canister-env";

export function getPlaceActor(identity?: Identity) {
  return createPlaceActor(placeCanisterId, {
    agentOptions: { rootKey, identity },
  });
}

export function getLedgerActor(identity?: Identity) {
  return createLedgerActor(ledgerCanisterId, {
    agentOptions: { rootKey, identity },
  });
}
