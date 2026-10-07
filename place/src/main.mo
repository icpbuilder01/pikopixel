import Principal "mo:core/Principal";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Char "mo:core/Char";
import Text "mo:core/Text";
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

// PikoPixel: a collaborative, fully on-chain pixel canvas (r/place-style),
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
  transient let PIXEL_FEE_E8S : Nat = 200_000_000; // 2 PIKO, burned per placement

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
  transient let MIN_PLACE_INTERVAL_NANOS : Int = 100_000_000; // 0.1s
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
      totalAdBurnedE8s;
      distinctPainters = Map.size(painterPlacements);
      gridSize = GRID_SIZE;
      paletteSize = Nat8.toNat(PALETTE_SIZE);
      pixelFeeE8s = PIXEL_FEE_E8S;
    };
  };

  public query func getRecentPlacements() : async [Types.RecentPlacement] { recentPlacements };

  // True lifetime leaderboard, read from painterPlacements itself rather
  // than derived from getRecentPlacements() -- that feed is capped at
  // MAX_RECENT (30) entries *total, across every painter*, so deriving a
  // leaderboard from it silently caps anyone's displayed count at 30 too
  // (worse the more other people are also painting, since they crowd out
  // your own entries in that shared window).
  public query func getTopPainters(limit : Nat) : async [Types.TopPainter] {
    let entries = Iter.toArray(Map.entries(painterPlacements));
    let sorted = Array.sort<(Principal, Nat)>(entries, func((_, a), (_, b)) { Nat.compare(b, a) });
    let capped = if (sorted.size() > limit) { limit } else { sorted.size() };
    Array.tabulate<Types.TopPainter>(capped, func(i) { let (p, n) = sorted[i]; { player = p; placements = n } });
  };

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

  // ---- Sponsored slots ----
  //
  // A handful of ad slots (text, optional link, optional small pixel-art
  // image), rented by burning PIKO -- the exact same
  // icrc2_transfer_from-to-the-minting-account path as placePixel, so this
  // canister still never holds any PIKO, even briefly. The active ads are
  // read (query, free) by this site, the browser mining site and
  // PikoNativeMiner.
  //
  // Ads are bought in PIKO *blocks*, not days (suggested by a community
  // member, 2026-10-07): when nobody mines, nobody is looking at the mining
  // apps either, so the ad simply stays up until enough blocks have gone
  // by. A hard time cap, scaled to the blocks paid for, still ends it if
  // the chain ever stops for good, so no slot can be held forever. Each slot runs one ad and
  // queues up to AD_MAX_QUEUE more, each starting where the previous ends.
  //
  // mother (PIKO's mining canister) lives on another subnet, so queries
  // here can't ask it for the height directly: a timer caches it every
  // HEIGHT_REFRESH_SECONDS, and every rental re-reads it fresh.
  //
  // Deliberately unmoderated: there is no controller function to edit or
  // hide an ad. Every frontend shows a "not verified" notice next to the
  // ads, players can flag them, and a flagged ad's image is hidden.
  // Burned PIKO can't be refunded by anyone.
  //
  // Pricing adjusts itself, so it never needs a controller to retune it
  // as PIKO's market price moves: every successful rental raises the
  // per-block price by AD_PRICE_STEP_UP_PCT, every full day without one
  // lowers it by AD_PRICE_DECAY_PCT, never below the floor (which is just
  // an anti-spam minimum). Decay is computed lazily from adBasePriceSetAt.

  transient let E8S : Nat = 100_000_000;
  transient let DAY_NANOS : Nat = 86_400_000_000_000;
  transient let AD_SLOT_COUNT : Nat = 3;
  // ~300 PIKO/day at the ~15 blocks/day PIKO actually averaged in late
  // September 2026 (far below the 288/day of the 5-minute target); the
  // daily decay below brings it down on its own if mining picks up.
  transient let AD_START_PRICE_PER_BLOCK_E8S : Nat = 20 * E8S;
  transient let AD_FLOOR_PRICE_PER_BLOCK_E8S : Nat = 3 * E8S;
  transient let AD_PRICE_STEP_UP_PCT : Nat = 120; // x1.2 after each rental
  transient let AD_PRICE_DECAY_PCT : Nat = 90; // x0.9 per full day without one
  transient let AD_MIN_BLOCKS : Nat = 1;
  transient let AD_MAX_BLOCKS : Nat = 288;
  transient let AD_MAX_QUEUE : Nat = 3;
  // The hard stop scales with what was paid for: 30 days for a 1-block
  // ad, plus 24h for every extra block -- so a paid ad isn't cut short
  // just because mining was slow or stopped for a while.
  transient let AD_LIFETIME_NANOS_PER_BLOCK : Nat = 24 * 3_600_000_000_000;
  transient let AD_MIN_LIFETIME_DAYS : Nat = 30;
  transient let AD_MAX_TEXT_CHARS : Nat = 80;
  transient let AD_MAX_LINK_CHARS : Nat = 100;
  transient let AD_IMAGE_WIDTH : Nat = 64;
  transient let AD_IMAGE_HEIGHT : Nat = 32;
  transient let AD_SUSPICIOUS_REPORTS : Nat = 3;
  // Past this many, more reports change nothing visible -- caps storage.
  transient let AD_MAX_STORED_REPORTERS : Nat = 50;
  transient let TARGET_BLOCK_SECONDS : Nat = 300; // mother's own 5-minute target, display only
  transient let HEIGHT_REFRESH_SECONDS : Nat = 60;

  // Dead since block-based queues replaced them (2026-10-08); kept only so
  // the stable signature stays compatible across that upgrade.
  var adSlots : [var ?Types.StoredAd] = VarArray.repeat<?Types.StoredAd>(null, AD_SLOT_COUNT);
  var adBasePricePerDayE8s : Nat = 0;

  var adQueues : [var [Types.AdEntry]] = VarArray.repeat<[Types.AdEntry]>([], AD_SLOT_COUNT);
  var nextAdId : Nat = 0;
  var adBasePricePerBlockE8s : Nat = AD_START_PRICE_PER_BLOCK_E8S;
  var adBasePriceSetAt : Time.Time = Time.now();
  var totalAdRentals : Nat = 0;
  var totalAdBurnedE8s : Nat = 0;
  // Set synchronously before rentAdSlot's first await and cleared after
  // its last, so two rentals of the same slot can never interleave.
  transient let adSlotInFlight : [var Bool] = VarArray.repeat<Bool>(false, AD_SLOT_COUNT);

  // mother is also PIKO's minting account, hence the same default. Same
  // set-then-lock pattern as pikoLedgerId: redirectable to a local mock
  // for development only.
  var motherId : Principal = Principal.fromText("45mjf-rqaaa-aaaaj-qsedq-cai");
  var motherLocked : Bool = false;
  var lastKnownHeight : Nat = 0;
  var heightUpdatedAt : Time.Time = 0;

  public shared ({ caller }) func setMotherId(id : Principal) : async () {
    requireController(caller);
    if (motherLocked) { Runtime.trap("mother id is permanently locked") };
    motherId := id;
  };

  public shared ({ caller }) func lockMotherId() : async () {
    requireController(caller);
    motherLocked := true;
  };

  func currentAdPricePerBlock(now : Time.Time) : Nat {
    var price = adBasePricePerBlockE8s;
    var days = if (now > adBasePriceSetAt) { Int.toNat(now - adBasePriceSetAt) / DAY_NANOS } else { 0 };
    while (days > 0 and price > AD_FLOOR_PRICE_PER_BLOCK_E8S) {
      price := price * AD_PRICE_DECAY_PCT / 100;
      days -= 1;
    };
    Nat.max(price, AD_FLOOR_PRICE_PER_BLOCK_E8S);
  };

  // Control characters, the C1 range, line/paragraph separators and
  // bidi overrides (which could visually reorder text to fake something
  // else) are rejected; everything else, emoji included, is fine.
  func isAllowedAdChar(c : Char) : Bool {
    let n = Char.toNat32(c);
    not (
      n < 32 or (n >= 127 and n <= 159) or n == 0x2028 or n == 0x2029 or
      (n >= 0x200E and n <= 0x200F) or (n >= 0x202A and n <= 0x202E) or
      (n >= 0x2066 and n <= 0x2069)
    );
  };

  func isValidAdText(text : Text) : Bool {
    if (text.size() == 0 or text.size() > AD_MAX_TEXT_CHARS) { return false };
    var hasVisible = false;
    for (c in text.chars()) {
      if (not isAllowedAdChar(c)) { return false };
      if (not Char.isWhitespace(c)) { hasVisible := true };
    };
    hasVisible;
  };

  // Printable ASCII only: no spaces, and no look-alike Unicode domains.
  func isValidAdLink(link : Text) : Bool {
    if (link.size() <= 8 or link.size() > AD_MAX_LINK_CHARS) { return false };
    if (not Text.startsWith(link, #text "https://")) { return false };
    for (c in link.chars()) {
      let n = Char.toNat32(c);
      if (n < 33 or n > 126) { return false };
    };
    true;
  };

  // Exactly one palette index per pixel -- the same palette as the canvas.
  func isValidAdImage(image : Blob) : Bool {
    if (image.size() != AD_IMAGE_WIDTH * AD_IMAGE_HEIGHT) { return false };
    for (b in image.vals()) {
      if (b >= PALETTE_SIZE) { return false };
    };
    true;
  };

  func adLifetimeNanos(blocks : Nat) : Nat {
    AD_MIN_LIFETIME_DAYS * DAY_NANOS + (if (blocks > 1) { blocks - 1 } else { 0 }) * AD_LIFETIME_NANOS_PER_BLOCK;
  };

  func entryFinished(e : Types.AdEntry, height : Nat, now : Time.Time) : Bool {
    switch (e.startHeight, e.startedAt) {
      case (?sh, ?st) { height >= sh + e.blocks or now >= st + adLifetimeNanos(e.blocks) };
      case _ { false };
    };
  };

  func entrySuspicious(e : Types.AdEntry) : Bool { e.reporters.size() >= AD_SUSPICIOUS_REPORTS };

  func adView(e : Types.AdEntry, height : Nat) : Types.Ad {
    let suspicious = entrySuspicious(e);
    {
      id = e.id;
      slot = e.slot;
      text = e.text;
      link = e.link;
      image = if (suspicious) { null } else { e.image };
      imageHidden = suspicious and e.image != null;
      advertiser = e.advertiser;
      blocks = e.blocks;
      blocksLeft = switch (e.startHeight) {
        case (?sh) { if (sh + e.blocks > height) { sh + e.blocks - height } else { 0 } };
        case null { e.blocks };
      };
      startHeight = e.startHeight;
      deadline = switch (e.startedAt) { case (?st) { ?(st + adLifetimeNanos(e.blocks)) }; case null { null } };
      burnedE8s = e.burnedE8s;
      reports = e.reporters.size();
      suspicious;
    };
  };

  // The not-yet-finished entries of a slot, in running order: [0] is the
  // ad on screen. Pure, so queries see the same thing advanceQueue() will
  // commit on the next timer tick.
  func liveEntries(slot : Nat, height : Nat, now : Time.Time) : [Types.AdEntry] {
    Array.filter<Types.AdEntry>(adQueues[slot], func(e) { not entryFinished(e, height, now) });
  };

  // Drops finished ads and starts the next one at the current height.
  func advanceQueue(slot : Nat, height : Nat, now : Time.Time) {
    let live = liveEntries(slot, height, now);
    adQueues[slot] := if (live.size() > 0 and live[0].startHeight == null) {
      Array.tabulate<Types.AdEntry>(
        live.size(),
        func(i) { if (i == 0) { { live[0] with startHeight = ?height; startedAt = ?now } } else { live[i] } },
      );
    } else { live };
  };

  func advanceAllQueues() {
    let now = Time.now();
    for (i in Nat.range(0, adQueues.size())) { advanceQueue(i, lastKnownHeight, now) };
  };

  // Never traps: false means mother couldn't be reached, and the cached
  // height is left as it was.
  func refreshHeight() : async* Bool {
    let Mother : Types.MotherActor = actor (Principal.toText(motherId));
    try {
      let stats = await Mother.getStats();
      lastKnownHeight := Nat.max(lastKnownHeight, stats.height);
      heightUpdatedAt := Time.now();
      true;
    } catch (_e) { false };
  };

  public shared query ({ caller }) func getAdMarket() : async Types.AdMarket {
    let now = Time.now();
    {
      slots = Array.tabulate<Types.AdSlot>(
        adQueues.size(),
        func(i) {
          let live = liveEntries(i, lastKnownHeight, now);
          let current = if (live.size() > 0) { ?live[0] } else { null };
          {
            slot = i;
            current = switch (current) { case (?e) { ?adView(e, lastKnownHeight) }; case null { null } };
            queue = Array.tabulate<Types.Ad>(
              if (live.size() > 0) { live.size() - 1 } else { 0 },
              func(j) { adView(live[j + 1], lastKnownHeight) },
            );
            reportedByMe = switch (current) {
              case (?e) { Array.find<Principal>(e.reporters, func(p) { p == caller }) != null };
              case null { false };
            };
          };
        },
      );
      pricePerBlockE8s = currentAdPricePerBlock(now);
      floorPricePerBlockE8s = AD_FLOOR_PRICE_PER_BLOCK_E8S;
      minBlocks = AD_MIN_BLOCKS;
      maxBlocks = AD_MAX_BLOCKS;
      maxQueue = AD_MAX_QUEUE;
      minLifetimeDays = AD_MIN_LIFETIME_DAYS;
      lifetimeHoursPerBlock = AD_LIFETIME_NANOS_PER_BLOCK / 3_600_000_000_000;
      maxTextChars = AD_MAX_TEXT_CHARS;
      maxLinkChars = AD_MAX_LINK_CHARS;
      imageWidth = AD_IMAGE_WIDTH;
      imageHeight = AD_IMAGE_HEIGHT;
      currentHeight = lastKnownHeight;
      heightUpdatedAt;
      targetBlockSeconds = TARGET_BLOCK_SECONDS;
      totalAdRentals;
      totalAdBurnedE8s;
      suspiciousAfterReports = AD_SUSPICIOUS_REPORTS;
    };
  };

  // The small, stable call the mining site and PikoNativeMiner poll: only
  // the ads currently on screen, nothing else.
  public query func getActiveAds() : async [Types.Ad] {
    let now = Time.now();
    var out : [Types.Ad] = [];
    for (i in Nat.range(0, adQueues.size())) {
      let live = liveEntries(i, lastKnownHeight, now);
      if (live.size() > 0) { out := Array.concat(out, [adView(live[0], lastKnownHeight)]) };
    };
    out;
  };

  // Rents a slot for `blocks` PIKO blocks: runs right away if the slot is
  // free, otherwise waits in its queue. `maxPricePerBlockE8s` protects the
  // caller from paying more than the price they were shown, since another
  // rental can raise it in between. Cost = price per block x blocks, burned.
  public shared ({ caller }) func rentAdSlot(
    slot : Nat,
    text : Text,
    link : ?Text,
    image : ?Blob,
    blocks : Nat,
    maxPricePerBlockE8s : Nat,
  ) : async Types.RentAdResult {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };

    // Shares placePixel's cooldown map: same purpose (no free tight-loop
    // ledger calls), and one map means one prune.
    let now = Time.now();
    switch (Map.get(lastPlaceAttempt, Principal.compare, caller)) {
      case (?last) {
        let remaining = MIN_PLACE_INTERVAL_NANOS - (now - last);
        if (remaining > 0) {
          return #Err(#TooSoon({ retryAfterNanos = Int.toNat(remaining) }));
        };
      };
      case null {};
    };
    Map.add(lastPlaceAttempt, Principal.compare, caller, now);

    if (slot >= adQueues.size()) { return #Err(#InvalidSlot) };
    if (blocks < AD_MIN_BLOCKS or blocks > AD_MAX_BLOCKS) { return #Err(#InvalidBlocks) };
    if (not isValidAdText(text)) { return #Err(#InvalidText) };
    switch (link) {
      case (?l) { if (not isValidAdLink(l)) { return #Err(#InvalidLink) } };
      case null {};
    };
    switch (image) {
      case (?img) { if (not isValidAdImage(img)) { return #Err(#InvalidImage) } };
      case null {};
    };
    if (adSlotInFlight[slot]) { return #Err(#SlotBusy) };
    if (liveEntries(slot, lastKnownHeight, now).size() > AD_MAX_QUEUE) { return #Err(#QueueFull) };

    let pricePerBlock = currentAdPricePerBlock(now);
    if (pricePerBlock > maxPricePerBlockE8s) {
      return #Err(#PriceAboveMax({ pricePerBlockE8s = pricePerBlock }));
    };
    let cost = pricePerBlock * blocks;

    adSlotInFlight[slot] := true;
    // Fresh height first: an ad that starts right now must start at the
    // real current block, and nothing is charged if mother is unreachable.
    if (not (await* refreshHeight())) {
      adSlotInFlight[slot] := false;
      return #Err(#HeightUnavailable);
    };
    let Ledger : Types.LedgerActor = actor (Principal.toText(pikoLedgerId));
    let outcome = try {
      ?(
        await Ledger.icrc2_transfer_from({
          spender_subaccount = null;
          from = { owner = caller; subaccount = null };
          to = { owner = pikoMintingAccount; subaccount = null };
          amount = cost;
          fee = null;
          memo = null;
          created_at_time = null;
        })
      );
    } catch (_e) { null };
    adSlotInFlight[slot] := false;

    switch (outcome) {
      case (? #Ok(_)) {};
      case (? #Err(e)) { return #Err(#TransferFailed(e)) };
      case null { return #Err(#TransferFailed(#TemporarilyUnavailable)) };
    };

    let paidAt = Time.now();
    let entry : Types.AdEntry = {
      id = nextAdId;
      slot;
      text;
      link;
      image;
      advertiser = caller;
      paidAt;
      blocks;
      burnedE8s = cost;
      startHeight = null;
      startedAt = null;
      reporters = [];
    };
    nextAdId += 1;
    advanceQueue(slot, lastKnownHeight, paidAt);
    adQueues[slot] := Array.concat(adQueues[slot], [entry]);
    advanceQueue(slot, lastKnownHeight, paidAt);
    totalAdRentals += 1;
    totalAdBurnedE8s += cost;
    adBasePricePerBlockE8s := currentAdPricePerBlock(paidAt) * AD_PRICE_STEP_UP_PCT / 100;
    adBasePriceSetAt := paidAt;
    let stored = switch (Array.find<Types.AdEntry>(adQueues[slot], func(e) { e.id == entry.id })) {
      case (?e) { e };
      case null { entry };
    };
    #Ok(adView(stored, lastKnownHeight));
  };

  // Flags the ad currently on screen in a slot. Only a warning label (and
  // its image hidden), never removal: once enough distinct painters flag
  // it, every frontend shows it as suspicious. Requiring at least one
  // placed pixel (a real 2 PIKO burn) keeps a swarm of free throwaway
  // logins from flagging every ad.
  public shared ({ caller }) func reportAd(slot : Nat) : async Types.ReportAdResult {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    if (slot >= adQueues.size()) { return #Err(#InvalidSlot) };
    let now = Time.now();
    advanceQueue(slot, lastKnownHeight, now);
    let queue = adQueues[slot];
    if (queue.size() == 0) { return #Err(#NoActiveAd) };
    let ad = queue[0];
    if (ad.advertiser == caller) { return #Err(#OwnAd) };
    switch (Map.get(painterPlacements, Principal.compare, caller)) {
      case (?n) { if (n == 0) { return #Err(#NotAPainter) } };
      case null { return #Err(#NotAPainter) };
    };
    if (Array.find<Principal>(ad.reporters, func(p) { p == caller }) != null) {
      return #Err(#AlreadyReported);
    };
    let reporters = if (ad.reporters.size() >= AD_MAX_STORED_REPORTERS) { ad.reporters } else {
      Array.concat(ad.reporters, [caller]);
    };
    let updated = { ad with reporters };
    adQueues[slot] := Array.tabulate<Types.AdEntry>(queue.size(), func(i) { if (i == 0) { updated } else { queue[i] } });
    #Ok({ reports = updated.reporters.size(); suspicious = entrySuspicious(updated) });
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

  transient var heightTimerId : ?Timer.TimerId = null;

  func armHeightTimer<system>() {
    switch (heightTimerId) {
      case (?id) { Timer.cancelTimer(id) };
      case null {};
    };
    heightTimerId := ?Timer.recurringTimer<system>(
      #seconds HEIGHT_REFRESH_SECONDS,
      func() : async () {
        ignore (await* refreshHeight());
        advanceAllQueues();
      },
    );
  };

  // Timers don't survive upgrades, and these top-level calls only run on
  // first install -- postupgrade re-arms both.
  system func postupgrade() {
    armSweepTimer<system>();
    armHeightTimer<system>();
  };

  armSweepTimer<system>();
  armHeightTimer<system>();
};
