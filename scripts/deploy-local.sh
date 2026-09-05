#!/usr/bin/env bash
# Deploys PikoPlace to its own local ICP network (free, for development/
# testing). Separate project from piko-icp on purpose -- see ../icp.yaml.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Starting local ICP network..."
icp network start -d

echo "==> Deploying test-ledger, place, place-frontend..."
icp deploy test-ledger place place-frontend -y

TEST_LEDGER_ID=$(icp canister status test-ledger -i)
DEPLOYER_ID=$(icp identity principal)
echo "==> Pointing place at the local test-ledger ($TEST_LEDGER_ID) instead of its real-mainnet default -- the local ledger's own minting account is the deployer identity ($DEPLOYER_ID), see test-ledger/icrc1_ledger_init.args..."
icp canister call place setPikoLedgerId "(principal \"$TEST_LEDGER_ID\", principal \"$DEPLOYER_ID\")"

PLACE_FRONTEND_ID=$(icp canister status place-frontend -i)

echo ""
echo "==> Done. Open PikoPlace at:"
echo "    http://${PLACE_FRONTEND_ID}.localhost:8080/"
echo ""
echo "==> To fund a test account with tPIKO, mint from the deployer identity ($DEPLOYER_ID) to a DIFFERENT principal (self-mint is rejected by the ledger):"
echo "    icp canister call test-ledger icrc1_transfer \"(record { to = record { owner = principal \\\"<some-other-principal>\\\" }; amount = 100_000_000_000_000 })\""
echo ""
echo "==> Then approve place to pull PIKO before placing a pixel, e.g.:"
echo "    icp canister call test-ledger icrc2_approve \"(record { spender = record { owner = principal \\\"$(icp canister status place -i)\\\" }; amount = 100_000_000_000_000 })\" --identity <that identity>"
