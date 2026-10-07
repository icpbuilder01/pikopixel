import Time "mo:core/Time";

module {
  /// Same minimal ICRC-1/ICRC-2 interface every canister in this project
  /// family declares for its ledger -- duplicated here rather than imported
  /// cross-canister (this project family's existing convention: each
  /// canister owns its own types.mo). PikoPixel only ever *pulls and
  /// burns*, never pays out, so it needs less of this interface than any
  /// sibling game (no icrc1_transfer, no balance queries).
  public type Account = { owner : Principal; subaccount : ?Blob };

  public type TransferFromArgs = {
    spender_subaccount : ?Blob;
    from : Account;
    to : Account;
    amount : Nat;
    fee : ?Nat;
    memo : ?Blob;
    created_at_time : ?Nat64;
  };

  public type TransferFromError = {
    #BadFee : { expected_fee : Nat };
    #BadBurn : { min_burn_amount : Nat };
    #InsufficientFunds : { balance : Nat };
    #InsufficientAllowance : { allowance : Nat };
    #TooOld;
    #CreatedInFuture : { ledger_time : Nat64 };
    #Duplicate : { duplicate_of : Nat };
    #TemporarilyUnavailable;
    #GenericError : { error_code : Nat; message : Text };
  };

  public type TransferFromResult = { #Ok : Nat; #Err : TransferFromError };

  public type LedgerActor = actor {
    icrc2_transfer_from : (TransferFromArgs) -> async TransferFromResult;
  };

  /// The IC management canister (aaaaa-aa). deposit_cycles is used by
  /// topUpPlaceFrontend() to share this canister's own cycles surplus with
  /// place-frontend, the same pattern every sibling game in this project
  /// family uses for its own frontend.
  public type ManagementActor = actor {
    deposit_cycles : ({ canister_id : Principal }) -> async ();
  };

  /// A placed (or about to be placed) pixel: (x, y) into the GRID_SIZE x
  /// GRID_SIZE canvas, `color` an index into place-frontend's own fixed
  /// palette -- this canister stores and validates only the index, never
  /// interprets it as an actual color.
  public type PlaceError = {
    #Anonymous;
    #TooSoon : { retryAfterNanos : Nat };
    #OutOfBounds;
    #InvalidColor;
    #TransferFailed : TransferFromError;
  };

  public type PlaceResult = { #Ok; #Err : PlaceError };

  public type RecentPlacement = {
    player : Principal;
    x : Nat;
    y : Nat;
    color : Nat8;
    timestamp : Time.Time;
  };

  // A painter's true lifetime placement count -- distinct from
  // RecentPlacement, which is only the last MAX_RECENT activity feed
  // entries and was never meant to double as a leaderboard source.
  public type TopPainter = {
    player : Principal;
    placements : Nat;
  };

  public type Stats = {
    totalPlacements : Nat;
    totalBurnedPiko : Nat; // pixels only
    totalAdBurnedE8s : Nat; // sponsored slots
    distinctPainters : Nat;
    gridSize : Nat;
    paletteSize : Nat;
    pixelFeeE8s : Nat;
  };

  public type Config = {
    pikoLedgerId : Principal;
    pikoLedgerLocked : Bool;
    pixelFeeE8s : Nat;
    gridSize : Nat;
    paletteSize : Nat;
  };

  // ---- Sponsored slots ----

  /// 2026-10-07's time-based slot record. Only still declared so the old
  /// `adSlots` stable var keeps a compatible type across the upgrade that
  /// replaced it with block-based queues -- nothing reads it any more.
  public type StoredAd = {
    slot : Nat;
    text : Text;
    link : ?Text;
    advertiser : Principal;
    rentedAt : Time.Time;
    expiresAt : Time.Time;
    burnedE8s : Nat;
    reporters : [Principal];
  };

  /// One paid ad, running or waiting in its slot's queue. It runs for
  /// `blocks` PIKO blocks from the height it actually started at (so it
  /// stays up while nobody mines), capped by a hard time limit so a dead
  /// chain can't hold a slot forever.
  public type AdEntry = {
    id : Nat;
    slot : Nat;
    text : Text;
    link : ?Text;
    image : ?Blob; // imageWidth x imageHeight palette indices, row by row
    advertiser : Principal;
    paidAt : Time.Time;
    blocks : Nat;
    burnedE8s : Nat;
    startHeight : ?Nat; // null while still waiting in the queue
    startedAt : ?Time.Time;
    reporters : [Principal];
  };

  public type Ad = {
    id : Nat;
    slot : Nat;
    text : Text;
    link : ?Text;
    image : ?Blob; // always null once suspicious
    imageHidden : Bool; // had an image, hidden because reported
    advertiser : Principal;
    blocks : Nat;
    blocksLeft : Nat;
    startHeight : ?Nat;
    deadline : ?Time.Time; // hard stop even if the chain stalls
    burnedE8s : Nat;
    reports : Nat; // distinct logged-in painters who flagged it
    suspicious : Bool; // reports >= the suspicious threshold: every frontend shows a warning
  };

  public type AdSlot = {
    slot : Nat;
    current : ?Ad;
    queue : [Ad]; // waiting, in the order they'll run
    reportedByMe : Bool; // the caller already flagged the running ad
  };

  public type AdMarket = {
    slots : [AdSlot];
    pricePerBlockE8s : Nat; // what a rental paid right now costs, per block
    floorPricePerBlockE8s : Nat;
    minBlocks : Nat;
    maxBlocks : Nat;
    maxQueue : Nat; // waiting ads allowed per slot, on top of the running one
    maxLifetimeDays : Nat;
    maxTextChars : Nat;
    maxLinkChars : Nat;
    imageWidth : Nat;
    imageHeight : Nat;
    currentHeight : Nat;
    heightUpdatedAt : Time.Time;
    targetBlockSeconds : Nat;
    totalAdRentals : Nat;
    totalAdBurnedE8s : Nat;
    suspiciousAfterReports : Nat;
  };

  public type RentAdError = {
    #Anonymous;
    #TooSoon : { retryAfterNanos : Nat };
    #InvalidSlot;
    #QueueFull;
    #SlotBusy; // another rental of this same slot is mid-flight
    #InvalidText;
    #InvalidLink;
    #InvalidImage;
    #InvalidBlocks;
    #HeightUnavailable; // couldn't read the current block height, nothing charged
    #PriceAboveMax : { pricePerBlockE8s : Nat };
    #TransferFailed : TransferFromError;
  };

  public type RentAdResult = { #Ok : Ad; #Err : RentAdError };

  public type ReportAdError = {
    #Anonymous;
    #InvalidSlot;
    #NoActiveAd;
    #NotAPainter; // only people who placed at least one pixel can report
    #OwnAd;
    #AlreadyReported;
  };

  public type ReportAdResult = { #Ok : { reports : Nat; suspicious : Bool }; #Err : ReportAdError };

  /// The one call place makes to mother (PIKO's mining canister). Candid
  /// lets the reply carry more fields than this; only height is read.
  public type MotherActor = actor {
    getStats : () -> async { height : Nat };
  };
}
