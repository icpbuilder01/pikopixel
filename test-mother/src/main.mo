// Mimics the shape of mother's getStats reply (height plus other fields
// place must ignore), with the height settable for local tests.
actor {
  var height : Nat = 100;

  public query func getStats() : async { height : Nat; difficultyBits : Nat; targetBlockTimeNanos : Nat } {
    { height; difficultyBits = 37; targetBlockTimeNanos = 300_000_000_000 };
  };

  public func setHeight(h : Nat) : async () { height := h };
};
