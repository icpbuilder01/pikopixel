import { useCallback, useEffect, useRef, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getPlaceActor, getLedgerActor } from "../lib/actors";
import { placeCanisterId } from "../lib/canister-env";
import { formatPiko } from "../lib/format";
import type { Config, PlaceError } from "../bindings/place/place";

interface CanvasProps {
  identity: Identity | null;
  onPlaced: () => void;
}

// A classic r/place-flavored 18-color palette. Purely a display concern --
// the backend only ever stores/validates the index (0-17), see
// place/src/main.mo's own PALETTE_SIZE comment (kept in lockstep with the
// length of this array). Orange and teal fill the two remaining gaps
// (between red/yellow, and between green/blue) left after #be0039 dark
// red replaced the original #ffa800 orange slot.
const PALETTE = [
  "#ffffff", "#d4d7d9", "#898d90", "#000000",
  "#be0039", "#ff4500", "#ffa800", "#ffd635",
  "#00a368", "#7eed56", "#009eaa", "#2450a4",
  "#3690ea", "#51e9f4", "#811e9f", "#b44ac0",
  "#ff99aa", "#6d482f",
];

const POLL_MS = 1000; // fast poll for other painters' placements, kept snappy alongside the optimistic local paint below
const CELL_PX = 6; // display size per cell at 1x -- scaled up via CSS below
const APPROVE_PLACEMENTS = 50; // how many pixels' worth of allowance to approve at once
const PIKO_LEDGER_FEE_E8S = 10_000n; // same gotcha as every sibling game's own approve flow

const placePrincipal = Principal.fromText(placeCanisterId);

function placeErrorMessage(err: PlaceError): string {
  switch (err.__kind__) {
    case "Anonymous":
      return "Log in to place a pixel.";
    case "TooSoon":
      return "Slow down a little -- try again in a moment.";
    case "OutOfBounds":
      return "That's outside the canvas.";
    case "InvalidColor":
      return "Pick a color from the palette.";
    case "TransferFailed": {
      const inner = err.TransferFailed;
      if (inner.__kind__ === "InsufficientAllowance") return "Approve more first.";
      if (inner.__kind__ === "InsufficientFunds") return "Not enough PIKO to burn a pixel.";
      return "Transfer failed -- try again.";
    }
    default:
      return "Couldn't place that pixel.";
  }
}

export function Canvas({ identity, onPlaced }: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [grid, setGrid] = useState<Uint8Array | null>(null);
  const [colorIndex, setColorIndex] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [approving, setApproving] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    getPlaceActor()
      .getConfig()
      .then(setConfig)
      .catch((err) => console.error("Failed to load place config", err));
  }, []);

  const refreshCanvas = useCallback(async () => {
    try {
      const canvas = await getPlaceActor().getCanvas();
      setGrid(new Uint8Array(canvas));
    } catch (err) {
      console.error("Failed to load canvas", err);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polling on-chain state, not derived
    refreshCanvas();
    const id = setInterval(refreshCanvas, POLL_MS);
    return () => clearInterval(id);
  }, [refreshCanvas]);

  const refreshAllowance = useCallback(async (id: Identity) => {
    try {
      const result = await getLedgerActor(id).icrc2_allowance({
        account: { owner: id.getPrincipal() },
        spender: { owner: placePrincipal },
      });
      setAllowance((result as { allowance: bigint }).allowance);
    } catch (err) {
      console.error("Failed to fetch place allowance", err);
    }
  }, []);

  useEffect(() => {
    if (identity) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with the ledger, not derived state
      refreshAllowance(identity);
    } else {
      setAllowance(null);
    }
  }, [identity, refreshAllowance]);

  const gridSize = config ? Number(config.gridSize) : 100;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !grid) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const idx = grid[y * gridSize + x] ?? 0;
        ctx.fillStyle = PALETTE[idx] ?? PALETTE[0];
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }, [grid, gridSize]);

  if (!config) {
    return (
      <section className="block place-panel">
        <h2 className="spark">
          Canvas <span className="section-icon">&#127912;</span>
        </h2>
        <div className="empty-state">Loading canvas...</div>
      </section>
    );
  }

  const pixelFee = config.pixelFeeE8s;
  const feeApproved = (allowance ?? 0n) >= pixelFee + PIKO_LEDGER_FEE_E8S;

  function cellFromEvent(e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * gridSize);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * gridSize);
    if (x < 0 || y < 0 || x >= gridSize || y >= gridSize) return null;
    return { x, y };
  }

  async function handleApprove() {
    if (!identity) return;
    setApproving(true);
    try {
      const approveAmount = (pixelFee + PIKO_LEDGER_FEE_E8S) * BigInt(APPROVE_PLACEMENTS);
      const result = await getLedgerActor(identity).icrc2_approve({
        spender: { owner: placePrincipal },
        amount: approveAmount,
      });
      if ("Ok" in (result as object)) {
        refreshAllowance(identity);
      } else {
        setMessage(`Approval failed: ${JSON.stringify((result as { Err: unknown }).Err)}`);
      }
    } catch (err) {
      console.error("Place approval failed", err);
      setMessage("Approval failed.");
    } finally {
      setApproving(false);
    }
  }

  // Paints a cell in the local grid immediately, without waiting on a
  // network round trip -- returns the cell's previous value so a failed
  // placement can be rolled back to it.
  function paintLocal(x: number, y: number, idx: number): number | null {
    let previous: number | null = null;
    setGrid((prev) => {
      if (!prev) return prev;
      previous = prev[y * gridSize + x] ?? 0;
      const next = new Uint8Array(prev);
      next[y * gridSize + x] = idx;
      return next;
    });
    return previous;
  }

  async function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!identity || placing) return;
    const cell = cellFromEvent(e);
    if (!cell) return;
    setMessage(null);
    setPlacing(true);
    const previous = paintLocal(cell.x, cell.y, colorIndex);
    try {
      const result = await getPlaceActor(identity).placePixel(BigInt(cell.x), BigInt(cell.y), colorIndex);
      if (result.__kind__ === "Ok") {
        refreshAllowance(identity);
        onPlaced();
      } else {
        if (previous !== null) paintLocal(cell.x, cell.y, previous);
        setMessage(placeErrorMessage(result.Err));
      }
    } catch (err) {
      console.error("placePixel failed", err);
      if (previous !== null) paintLocal(cell.x, cell.y, previous);
      setMessage("Placement failed, nothing was charged if this was a network error.");
    } finally {
      setPlacing(false);
    }
  }

  return (
    <section className="block place-panel">
      <div className="miner-panel-head">
        <h2 className="spark">
          Canvas <span className="section-icon">&#127912;</span>
        </h2>
        <span className="dice-edge-pill">
          {gridSize}x{gridSize}, {formatPiko(pixelFee)} PIKO per pixel, burned
        </span>
      </div>
      <p className="section-intro">
        Click a cell to burn {formatPiko(pixelFee)} PIKO and paint it your chosen color. The PIKO goes
        straight to the ledger's minting account -- a real burn, removed from supply, never held by
        this canister.
      </p>

      <div className="place-canvas-wrap">
        <canvas
          ref={canvasRef}
          width={gridSize}
          height={gridSize}
          className={`place-canvas ${placing ? "is-placing" : ""}`}
          onClick={handleClick}
          onMouseMove={(e) => setHover(cellFromEvent(e))}
          onMouseLeave={() => setHover(null)}
          style={{ width: gridSize * CELL_PX }}
        />
      </div>

      <div className="place-controls">
        <div className="place-palette">
          {PALETTE.map((hex, i) => (
            <button
              key={hex}
              type="button"
              className={`place-swatch ${colorIndex === i ? "active" : ""}`}
              style={{ background: hex }}
              onClick={() => setColorIndex(i)}
              aria-label={`Color ${i}`}
            />
          ))}
        </div>

        {!identity ? (
          <p className="empty-state">Log in to place a pixel.</p>
        ) : !feeApproved ? (
          <button className="button" onClick={handleApprove} disabled={approving}>
            {approving ? "Approving..." : `Approve ${APPROVE_PLACEMENTS} pixels' worth of PIKO`}
          </button>
        ) : (
          <p className="wallet-hint">
            {hover ? `Cell (${hover.x}, ${hover.y})` : "Hover the canvas"} -- click to burn{" "}
            {formatPiko(pixelFee)} PIKO and place your color.
          </p>
        )}
        {message && <p className="mining-message critical">{message}</p>}
      </div>
    </section>
  );
}
