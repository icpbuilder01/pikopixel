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

// A classic r/place-flavored 16-color palette. Purely a display concern --
// the backend only ever stores/validates the index (0-15), see
// place/src/main.mo's own PALETTE_SIZE comment.
const PALETTE = [
  "#ffffff", "#d4d7d9", "#898d90", "#000000",
  "#ff4500", "#ffa800", "#ffd635", "#00a368",
  "#7eed56", "#2450a4", "#3690ea", "#51e9f4",
  "#811e9f", "#b44ac0", "#ff99aa", "#6d482f",
];

const POLL_MS = 3000;
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
  const [balance, setBalance] = useState<bigint | null>(null);
  const [approving, setApproving] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  const refreshBalance = useCallback(async (id: Identity) => {
    try {
      const raw = await getLedgerActor(id).icrc1_balance_of({ owner: id.getPrincipal() });
      setBalance(raw as unknown as bigint);
    } catch (err) {
      console.error("Failed to fetch place balance", err);
    }
  }, []);

  useEffect(() => {
    if (identity) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with the ledger, not derived state
      refreshAllowance(identity);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with the ledger, not derived state
      refreshBalance(identity);
    } else {
      setAllowance(null);
      setBalance(null);
    }
  }, [identity, refreshAllowance, refreshBalance]);

  async function handleCopyPrincipal() {
    if (!identity) return;
    await navigator.clipboard.writeText(identity.getPrincipal().toText());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

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

  async function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!identity || placing) return;
    const cell = cellFromEvent(e);
    if (!cell) return;
    setMessage(null);
    setPlacing(true);
    try {
      const result = await getPlaceActor(identity).placePixel(BigInt(cell.x), BigInt(cell.y), colorIndex);
      if (result.__kind__ === "Ok") {
        refreshAllowance(identity);
        refreshBalance(identity);
        refreshCanvas();
        onPlaced();
      } else {
        setMessage(placeErrorMessage(result.Err));
      }
    } catch (err) {
      console.error("placePixel failed", err);
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
          style={{ width: gridSize * CELL_PX, height: gridSize * CELL_PX }}
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

        {identity && (
          <div className="wallet-address-row">
            <code className="wallet-address">
              {formatPiko(balance ?? 0n)} PIKO -- {identity.getPrincipal().toText()}
            </code>
            <button type="button" className="button secondary small" onClick={handleCopyPrincipal}>
              {copied ? "Copied" : "Copy principal"}
            </button>
          </div>
        )}
        {identity && balance !== null && balance < pixelFee + PIKO_LEDGER_FEE_E8S && (
          <p className="wallet-hint">
            That's a different principal than any other PIKO site you've used -- Internet Identity
            derives one per site. Send PIKO here (from PikoPay, an exchange, or another wallet) before
            approving.
          </p>
        )}

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
