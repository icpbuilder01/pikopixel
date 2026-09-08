import Principal "mo:core/Principal";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Int "mo:core/Int";
import Time "mo:core/Time";
import Cycles "mo:core/Cycles";
import Array "mo:core/Array";
import VarArray "mo:core/VarArray";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Runtime "mo:core/Runtime";
import Timer "mo:core/Timer";
import Types "types";

// PikoPlace: a collaborative, fully on-chain pixel canvas (r/place-style),
// paid in PIKO. Every placed pixel burns a small, fixed amount of PIKO --
// pulled from the player (who approves this canister first, same
// icrc2_transfer_from pattern every sibling game uses to pull a stake)
// and sent straight to the PIKO ledger's own minting account, which is
// what makes it a real ICRC-1 burn (removed from total supply, verifiable
// on the ledger itself), not something this canister ever custodies.
//
// That's the deliberate difference from every other game in this family:
// there is no bankroll, no payout, no withdrawal path, no timelocked risk
// config -- PIKO spent here never comes back to anyone, by design, same
// "disclosed, not hidden" posture as the rest of this project family.
// Simplicity is the point: this is a community/art piece, not a bet.
//
// Independent icp-cli project, same reasoning as PikoPay/PikoPoker/
// PikoLottery/PikoRoulette/PikoBlackjack (see their own repos' icp.yaml):
// not part of piko-icp's own deploy/canister lifecycle.
actor self {

  transient let GRID_SIZE : Nat = 100; // 100x100 = 10,000 pixels
  // Purely a display concern -- see place-frontend's own palette for the
  // actual 18 colors. This canister only ever stores/validates an index.
  transient let PALETTE_SIZE : Nat8 = 18;
  transient let PIXEL_FEE_E8S : Nat = 100_000_000; // 1 PIKO, burned per placement

  // 0 = the palette's first color (white). Flat row-major array, index =
  // y * GRID_SIZE + x -- 10,000 bytes, trivially cheap to store and to
  // return whole from getCanvas().
  var grid : [var Nat8] = VarArray.repeat<Nat8>(0, GRID_SIZE * GRID_SIZE);

  // ---- Ledger wiring ----
  // Real PIKO ledger by default; controller-only escape hatch to point at
  // a local test-ledger during development, closed off for good by
  // lockPikoLedgerId() before this is ever trusted with real funds on
  // mainnet -- same pattern as every sibling game's own pikoLedgerId.
  // pikoMintingAccount is that ledger's own burn address (mother's
  // principal on the real PIKO ledger, confirmed live via the ledger's
  // own icrc1_minting_account query) -- different on test-ledger, so it's
  // redirected in lockstep with pikoLedgerId via setPikoLedgerId's second
  // argument, never hardcoded to the mainnet value everywhere.
  var pikoLedgerId : Principal = Principal.fromText("56aad-fiaaa-aaaaj-qsefa-cai");
  var pikoMintingAccount : Principal = Principal.fromText("45mjf-rqaaa-aaaaj-qsedq-cai");
  var pikoLedgerLocked : Bool = false;

  func requireController(caller : Principal) {
    if (not Principal.isController(caller)) { Runtime.trap("only a controller can call this") };
  };

  public shared ({ caller }) func setPikoLedgerId(id : Principal, mintingAccount : Principal) : async () {
    requireController(caller);
    if (pikoLedgerLocked) { Runtime.trap("piko ledger id is permanently locked") };
    pikoLedgerId := id;
    pikoMintingAccount := mintingAccount;
  };

  public shared ({ caller }) func lockPikoLedgerId() : async () {
    requireController(caller);
    pikoLedgerLocked := true;
  };

  // place-frontend has no revenue mechanism of its own -- same gap every
  // sibling game's topUp*Frontend() fills. Optional (not trapping if
  // unset), since this env var only exists once place-frontend has
  // actually been deployed alongside this canister.
  let placeFrontendId : ?Principal = switch (Runtime.envVar<system>("PUBLIC_CANISTER_ID:place-frontend")) {
    case (?text) { ?Principal.fromText(text) };
    case null { null };
  };

  transient let CYCLES_RESERVE : Nat = 2_000_000_000_000; // 2T, same floor as the rest of this project family
  transient let MIN_MAINTENANCE_INTERVAL_NANOS : Int = 60_000_000_000; // 60s
  var lastTopUpPlaceFrontendAt : Int = 0;

  // Same anti-spam cooldown every sibling game now builds in from the
  // start (see PikoRoulette's own placeBet comment for the history) --
  // without it, a caller with no PIKO/allowance can call placePixel in a
  // tight loop and force a real icrc2_transfer_from attempt for free,
  // even though it will always fail.
  transient let MIN_PLACE_INTERVAL_NANOS : Int = 300_000_000; // 0.3s
  transient let lastPlaceAttempt : Map.Map<Principal, Time.Time> = Map.empty<Principal, Time.Time>();

  // ---- Stats (persisted, purely informational) ----
  var totalPlacements : Nat = 0;
  var totalBurnedPiko : Nat = 0;
  let painterPlacements : Map.Map<Principal, Nat> = Map.empty<Principal, Nat>();

  let MAX_RECENT : Nat = 30;
  var recentPlacements : [Types.RecentPlacement] = [];

  func pushRecent(p : Types.RecentPlacement) {
    let combined = Array.concat(recentPlacements, [p]);
    let n = combined.size();
    recentPlacements := if (n > MAX_RECENT) {
      Array.tabulate<Types.RecentPlacement>(MAX_RECENT, func(i) { combined[n - MAX_RECENT + i] });
    } else { combined };
  };

  // ---- Public API ----

  public query func getConfig() : async Types.Config {
    {
      pikoLedgerId;
      pikoLedgerLocked;
      pixelFeeE8s = PIXEL_FEE_E8S;
      gridSize = GRID_SIZE;
      paletteSize = Nat8.toNat(PALETTE_SIZE);
    };
  };

  public query func getCanvas() : async [Nat8] { VarArray.toArray(grid) };

  public query func getStats() : async Types.Stats {
    {
      totalPlacements;
      totalBurnedPiko;
      distinctPainters = Map.size(painterPlacements);
      gridSize = GRID_SIZE;
      paletteSize = Nat8.toNat(PALETTE_SIZE);
      pixelFeeE8s = PIXEL_FEE_E8S;
    };
  };

  public query func getRecentPlacements() : async [Types.RecentPlacement] { recentPlacements };

  // Controller-only: wipes the canvas back to blank and zeroes every stat/
  // leaderboard/recent-activity record. Doesn't touch pikoLedgerId or its
  // lock, and doesn't undo anything -- PIKO already burned through
  // placePixel already left circulating supply for good and stays on the
  // ledger's own immutable history regardless of what this canister's own
  // scoreboard shows afterward. For resetting the display, not the money.
  public shared ({ caller }) func resetCanvas() : async () {
    requireController(caller);
    grid := VarArray.repeat<Nat8>(0, GRID_SIZE * GRID_SIZE);
    totalPlacements := 0;
    totalBurnedPiko := 0;
    Map.clear(painterPlacements);
    recentPlacements := [];
  };

  // Pulls the fixed pixel fee straight from the player to the ledger's
  // own minting account -- a real ICRC-1 burn, atomic with the pull
  // itself (the ledger either moves it there or the whole call fails; it
  // never lands anywhere in between). This canister never holds the PIKO
  // even transiently, unlike every sibling game's bankroll -- there is
  // deliberately no withdrawal path here because there is never anything
  // for a controller to withdraw.
  public shared ({ caller }) func placePixel(x : Nat, y : Nat, color : Nat8) : async Types.PlaceResult {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };

    let now = Time.now();
    switch (Map.get(lastPlaceAttempt, Principal.compare, caller)) {
      case (?last) {
        let elapsed = now - last;
        let remaining = MIN_PLACE_INTERVAL_NANOS - elapsed;
        if (remaining > 0) {
          return #Err(#TooSoon({ retryAfterNanos = Int.toNat(remaining) }));
        };
      };
      case null {};
    };
    Map.add(lastPlaceAttempt, Principal.compare, caller, now);

    if (x >= GRID_SIZE or y >= GRID_SIZE) { return #Err(#OutOfBounds) };
    if (color >= PALETTE_SIZE) { return #Err(#InvalidColor) };

    let Ledger : Types.LedgerActor = actor (Principal.toText(pikoLedgerId));
    let outcome = try {
      ?(
        await Ledger.icrc2_transfer_from({
          spender_subaccount = null;
          from = { owner = caller; subaccount = null };
          to = { owner = pikoMintingAccount; subaccount = null };
          amount = PIXEL_FEE_E8S;
          fee = null;
          memo = null;
          created_at_time = null;
        })
      );
    } catch (_e) { null };

    switch (outcome) {
      case (? #Ok(_)) {};
      case (? #Err(e)) { return #Err(#TransferFailed(e)) };
      case null { return #Err(#TransferFailed(#TemporarilyUnavailable)) };
    };

    grid[y * GRID_SIZE + x] := color;
    totalPlacements += 1;
    totalBurnedPiko += PIXEL_FEE_E8S;
    let prior = switch (Map.get(painterPlacements, Principal.compare, caller)) {
      case (?v) { v };
      case null { 0 };
    };
    Map.add(painterPlacements, Principal.compare, caller, prior + 1);
    pushRecent({ player = caller; x; y; color; timestamp = now });
    #Ok;
  };

  // ---- Cycles top-up (no ICP/PIKO income of its own to convert -- every
  // burn leaves the ecosystem entirely rather than landing in this
  // canister -- so, same as PikoRoulette/PikoLottery, this depends on
  // mother's/manual top-ups for its own cycles; this only relays surplus
  // on to its frontend) ----

  public shared func topUpPlaceFrontend() : async { sent : Nat } {
    let now = Time.now();
    if (now - lastTopUpPlaceFrontendAt < MIN_MAINTENANCE_INTERVAL_NANOS) {
      return { sent = 0 };
    };
    lastTopUpPlaceFrontendAt := now; // set synchronously, before any await below, so a burst of concurrent calls only lets one through

    let balance = Cycles.balance();
    if (balance <= CYCLES_RESERVE) { return { sent = 0 } };
    switch (placeFrontendId) {
      case null { { sent = 0 } };
      case (?target) {
        let surplus = balance - CYCLES_RESERVE;
        let Management : Types.ManagementActor = actor ("aaaaa-aa");
        let outcome = try {
          await (with cycles = surplus) Management.deposit_cycles({ canister_id = target });
          ?();
        } catch (_e) { null };
        switch (outcome) {
          case (?()) { { sent = surplus } };
          case null { { sent = 0 } };
        };
      };
    };
  };

  // lastPlaceAttempt is transient and unbounded: any caller can add an
  // entry for free, but an entry older than its own cooldown window is
  // provably stale and safe to drop. Fired automatically on the sweep
  // timer, same as every sibling game's own pruneStale*.
  public shared func pruneStalePlaceAttempts() : async Nat {
    let now = Time.now();
    let entries = Iter.toArray(Map.entries(lastPlaceAttempt));
    let stale = Array.filter<(Principal, Time.Time)>(
      entries,
      func((_, t)) { now - t > MIN_PLACE_INTERVAL_NANOS },
    );
    for ((p, _) in stale.vals()) {
      Map.remove(lastPlaceAttempt, Principal.compare, p);
    };
    stale.size();
  };

  transient let SWEEP_INTERVAL_SECONDS_LIVE : Nat = 900; // 15 minutes, same cadence as the rest of this project family
  transient var sweepTimerId : ?Timer.TimerId = null;

  func armSweepTimer<system>() {
    switch (sweepTimerId) {
      case (?id) { Timer.cancelTimer(id) };
      case null {};
    };
    sweepTimerId := ?Timer.recurringTimer<system>(
      #seconds SWEEP_INTERVAL_SECONDS_LIVE,
      func() : async () {
        ignore (await topUpPlaceFrontend());
        ignore (await pruneStalePlaceAttempts());
      },
    );
  };

  system func postupgrade() { armSweepTimer<system>() };

  armSweepTimer<system>();
};
