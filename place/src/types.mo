import Time "mo:core/Time";

module {
  /// Same minimal ICRC-1/ICRC-2 interface every canister in this project
  /// family declares for its ledger -- duplicated here rather than imported
  /// cross-canister (this project family's existing convention: each
  /// canister owns its own types.mo). PikoPlace only ever *pulls and
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

  public type Stats = {
    totalPlacements : Nat;
    totalBurnedPiko : Nat;
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
}
