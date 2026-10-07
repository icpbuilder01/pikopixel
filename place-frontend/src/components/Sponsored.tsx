import { useCallback, useEffect, useRef, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getPlaceActor, getLedgerActor } from "../lib/actors";
import { placeCanisterId } from "../lib/canister-env";
import { formatPiko, shortPrincipal } from "../lib/format";
import { PALETTE } from "../lib/palette";
import { pixelateImageFile } from "../lib/pixelate";
import { ReportAdError, type Ad, type AdMarket, type RentAdError } from "../bindings/place/place";

// Shown next to every ad, everywhere ads appear (this site, the browser
// mining site, PikoNativeMiner): nobody reviews these, by design.
export const AD_DISCLAIMER = "Sponsored · not verified by PIKO · do your own research";
export const SUSPICIOUS_WARNING = "⚠ Reported as suspicious by several players -- be extra careful";

const POLL_MS = 10_000;
const ROTATE_MS = 8_000;
const PIKO_LEDGER_FEE_E8S = 10_000n; // same gotcha as Canvas.tsx's approve flow
const IMAGE_WIDTH = 64; // must match AD_IMAGE_WIDTH/HEIGHT in place/src/main.mo
const IMAGE_HEIGHT = 32;

const placePrincipal = Principal.fromText(placeCanisterId);

/** "≈ 1 day 4 h" for a number of blocks at the chain's target block time. */
function blocksToDuration(blocks: bigint | number, targetSeconds: bigint | number): string {
  const minutes = Math.round((Number(blocks) * Number(targetSeconds)) / 60);
  if (minutes < 60) return `≈ ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `≈ ${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `≈ ${days} day${days > 1 ? "s" : ""}` : `≈ ${days} day${days > 1 ? "s" : ""} ${hours % 24} h`;
}

function rentErrorMessage(err: RentAdError): string {
  switch (err.__kind__) {
    case "Anonymous":
      return "Log in to rent a slot.";
    case "TooSoon":
      return "Slow down a little -- try again in a moment.";
    case "InvalidSlot":
      return "That slot doesn't exist.";
    case "QueueFull":
      return "That slot's waiting list is full -- try another slot.";
    case "SlotBusy":
      return "Someone is renting that slot right now -- try again in a few seconds.";
    case "InvalidText":
      return "Text must be 1-80 characters, on one line.";
    case "InvalidLink":
      return "Link must start with https:// and contain no spaces or special characters.";
    case "InvalidImage":
      return "The image is invalid -- clear it and draw it again.";
    case "InvalidBlocks":
      return "Pick a duration within the allowed range.";
    case "HeightUnavailable":
      return "Couldn't read the current PIKO block height -- nothing was charged, try again.";
    case "PriceAboveMax":
      return `The price just changed to ${formatPiko(err.PriceAboveMax.pricePerBlockE8s)} PIKO/block -- check it and try again.`;
    case "TransferFailed": {
      const inner = err.TransferFailed;
      if (inner.__kind__ === "InsufficientFunds") return "Not enough PIKO for this rental.";
      if (inner.__kind__ === "InsufficientAllowance") return "Allowance too low -- try again.";
      return "Transfer failed -- try again.";
    }
    default:
      return "Couldn't rent that slot.";
  }
}

function reportErrorMessage(err: ReportAdError): string {
  switch (err) {
    case ReportAdError.Anonymous:
      return "Log in to report an ad.";
    case ReportAdError.NotAPainter:
      return "Place at least one pixel first -- that's what stops throwaway accounts from flagging every ad.";
    case ReportAdError.AlreadyReported:
      return "You already reported this ad.";
    case ReportAdError.OwnAd:
      return "That's your own ad.";
    case ReportAdError.NoActiveAd:
      return "That ad already ended.";
    default:
      return "Couldn't report that ad.";
  }
}

/** Renders a 32x16 palette-index image, scaled up with crisp pixels. */
export function AdImage({ image, scale = 2 }: { image: Uint8Array; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    for (let i = 0; i < IMAGE_WIDTH * IMAGE_HEIGHT; i++) {
      ctx.fillStyle = PALETTE[image[i]] ?? PALETTE[0];
      ctx.fillRect(i % IMAGE_WIDTH, Math.floor(i / IMAGE_WIDTH), 1, 1);
    }
  }, [image]);
  return (
    <canvas
      ref={ref}
      className="board-image"
      width={IMAGE_WIDTH}
      height={IMAGE_HEIGHT}
      style={{ width: IMAGE_WIDTH * scale, height: IMAGE_HEIGHT * scale }}
    />
  );
}

/** Click or drag to paint a 32x16 image with the canvas palette. */
function ImageEditor({
  value,
  onChange,
}: {
  value: Uint8Array;
  onChange: React.Dispatch<React.SetStateAction<Uint8Array>>;
}) {
  const [color, setColor] = useState(3);
  const [dither, setDither] = useState(true);
  const [importError, setImportError] = useState<string | null>(null);
  const painting = useRef(false);
  const scale = 10;

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportError(null);
    try {
      onChange(await pixelateImageFile(file, IMAGE_WIDTH, IMAGE_HEIGHT, dither));
    } catch (err) {
      console.error("Image import failed", err);
      setImportError("Couldn't read that image -- try a PNG or JPEG.");
    }
  }

  function paintAt(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * IMAGE_WIDTH);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * IMAGE_HEIGHT);
    if (x < 0 || y < 0 || x >= IMAGE_WIDTH || y >= IMAGE_HEIGHT) return;
    const i = y * IMAGE_WIDTH + x;
    // From the latest image, not this render's: several pointer events can
    // land before React re-renders during a fast drag.
    onChange((prev) => {
      if (prev[i] === color) return prev;
      const next = prev.slice();
      next[i] = color;
      return next;
    });
  }

  return (
    <div className="board-editor">
      <div className="board-import">
        <label className="button secondary small">
          Import an image
          <input type="file" accept="image/*" onChange={handleImport} hidden />
        </label>
        <label className="board-toggle">
          <input type="checkbox" checked={dither} onChange={(e) => setDither(e.target.checked)} /> Smooth colors
          (best for photos)
        </label>
      </div>
      <p className="wallet-hint">
        Turned into {IMAGE_WIDTH}x{IMAGE_HEIGHT} pixel art right here in your browser, nothing is uploaded. Then
        touch it up by clicking or dragging.
      </p>
      {importError && <p className="mining-message critical">{importError}</p>}
      <div
        className="board-editor-surface"
        style={{ width: IMAGE_WIDTH * scale, maxWidth: "100%", aspectRatio: `${IMAGE_WIDTH} / ${IMAGE_HEIGHT}` }}
        onPointerDown={(e) => {
          painting.current = true;
          paintAt(e);
          try {
            // Keeps a drag painting even when it leaves the surface briefly.
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Not available for this pointer; dragging just stops at the edge.
          }
        }}
        onPointerMove={(e) => painting.current && paintAt(e)}
        onPointerUp={() => (painting.current = false)}
        onPointerCancel={() => (painting.current = false)}
      >
        <AdImage image={value} scale={scale} />
      </div>
      <div className="place-palette">
        {PALETTE.map((hex, i) => (
          <button
            key={hex}
            type="button"
            className={`place-swatch ${color === i ? "active" : ""}`}
            style={{ background: hex }}
            onClick={() => setColor(i)}
            aria-label={`Color ${i}`}
          />
        ))}
      </div>
      <button type="button" className="button secondary small" onClick={() => onChange(new Uint8Array(IMAGE_WIDTH * IMAGE_HEIGHT))}>
        Clear image
      </button>
    </div>
  );
}

/** Rotating banner of the ads currently on screen. Renders nothing when there are none. */
export function SponsoredBanner() {
  const [ads, setAds] = useState<Ad[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const load = () =>
      getPlaceActor()
        .getActiveAds()
        .then(setAds)
        .catch((err) => console.error("Failed to load ads", err));
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (ads.length < 2) return;
    const id = setInterval(() => setIndex((i) => i + 1), ROTATE_MS);
    return () => clearInterval(id);
  }, [ads.length]);

  if (ads.length === 0) return null;
  const ad = ads[index % ads.length];
  return (
    <aside className="board-strip" aria-label="Community board">
      <span className="board-strip-label">{AD_DISCLAIMER}</span>
      {ad.suspicious && <span className="board-warning">{SUSPICIOUS_WARNING}</span>}
      {ad.image && <AdImage image={ad.image} />}
      <span className="board-strip-text">{ad.text}</span>
      {ad.link && (
        <a className="board-strip-link mono" href={ad.link} target="_blank" rel="noopener noreferrer nofollow">
          {ad.link}
        </a>
      )}
    </aside>
  );
}

interface AdvertiseProps {
  identity: Identity | null;
  onRented: () => void;
}

export function Advertise({ identity, onRented }: AdvertiseProps) {
  const [market, setMarket] = useState<AdMarket | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  const [withImage, setWithImage] = useState(false);
  const [image, setImage] = useState(() => new Uint8Array(IMAGE_WIDTH * IMAGE_HEIGHT));
  const [blocks, setBlocks] = useState(24);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "good" | "critical"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMarket(await getPlaceActor(identity ?? undefined).getAdMarket());
    } catch (err) {
      console.error("Failed to load ad market", err);
    }
  }, [identity]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polling on-chain state, not derived
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  if (!market) {
    return (
      <section className="block">
        <h2>
          Advertise <span className="section-icon">📣</span>
        </h2>
        <div className="empty-state">Loading ad slots...</div>
      </section>
    );
  }

  const me = identity?.getPrincipal().toText();
  const maxQueue = Number(market.maxQueue);
  const selected = market.slots.find((s) => Number(s.slot) === slot) ?? null;
  // Blocks to wait before a new ad in the selected slot would start.
  const waitBlocks = selected
    ? (selected.current?.blocksLeft ?? 0n) + selected.queue.reduce((sum, a) => sum + a.blocks, 0n)
    : 0n;
  const price = market.pricePerBlockE8s;
  const cost = price * BigInt(blocks);
  const minBlocks = Number(market.minBlocks);
  const maxBlocks = Number(market.maxBlocks);

  function pick(n: number) {
    setSlot(n);
    setMessage(null);
  }

  async function handleReport(n: number) {
    if (!identity) return;
    if (!window.confirm(`Report the ad in slot ${n + 1} as a scam or abusive? It adds a public warning (and hides its image) once several players report it.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await getPlaceActor(identity).reportAd(BigInt(n));
      if (result.__kind__ === "Ok") {
        setMessage({
          kind: "good",
          text: result.Ok.suspicious
            ? "Reported -- this ad is now shown with a warning everywhere, and its image is hidden."
            : `Reported (${result.Ok.reports.toString()}/${market?.suspiciousAfterReports.toString()} before a warning is shown).`,
        });
      } else {
        setMessage({ kind: "critical", text: reportErrorMessage(result.Err) });
      }
      refresh();
    } catch (err) {
      console.error("reportAd failed", err);
      setMessage({ kind: "critical", text: "Report failed -- try again." });
    } finally {
      setBusy(false);
    }
  }

  async function handleRent(e: React.FormEvent) {
    e.preventDefault();
    if (!identity || slot === null) return;
    setBusy(true);
    setMessage(null);
    try {
      // Add this rental's cost on top of whatever allowance is already
      // there (e.g. left for painting pixels) instead of overwriting it.
      const ledger = getLedgerActor(identity);
      const current = (await ledger.icrc2_allowance({
        account: { owner: identity.getPrincipal() },
        spender: { owner: placePrincipal },
      })) as { allowance: bigint };
      if (current.allowance < cost + PIKO_LEDGER_FEE_E8S) {
        const approval = await ledger.icrc2_approve({
          spender: { owner: placePrincipal },
          amount: current.allowance + cost + PIKO_LEDGER_FEE_E8S,
        });
        if (!("Ok" in (approval as object))) {
          setMessage({ kind: "critical", text: `Approval failed: ${JSON.stringify((approval as { Err: unknown }).Err)}` });
          return;
        }
      }
      const trimmedLink = link.trim();
      const result = await getPlaceActor(identity).rentAdSlot(
        BigInt(slot),
        text.trim(),
        trimmedLink === "" ? null : trimmedLink,
        withImage ? image : null,
        BigInt(blocks),
        price,
      );
      if (result.__kind__ === "Ok") {
        setMessage({
          kind: "good",
          text:
            result.Ok.startHeight !== undefined
              ? `Done -- ${formatPiko(cost)} PIKO burned, your ad is live for the next ${blocks} blocks.`
              : `Done -- ${formatPiko(cost)} PIKO burned, your ad is queued and starts after ${waitBlocks.toString()} more blocks.`,
        });
        setSlot(null);
        refresh();
        onRented();
      } else {
        setMessage({ kind: "critical", text: rentErrorMessage(result.Err) });
        refresh();
      }
    } catch (err) {
      console.error("rentAdSlot failed", err);
      setMessage({ kind: "critical", text: "Rental failed, nothing was charged if this was a network error." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="block">
      <div className="miner-panel-head">
        <h2>
          Advertise <span className="section-icon">📣</span>
        </h2>
        <span className="dice-edge-pill">{formatPiko(price)} PIKO / block, burned</span>
      </div>
      <p className="section-intro">
        Rent one of {market.slots.length} slots shown on PikoPixel, the PIKO mining site and the
        PikoNativeMiner app: a line of text, an optional link and an optional {IMAGE_WIDTH}x{IMAGE_HEIGHT}{" "}
        pixel image. You pay per PIKO <strong>block</strong>, by burning PIKO: your ad stays up until that
        many blocks are mined, so it never runs out while nobody is mining (safety stop only after{" "}
        {market.stallStopDays.toString()} days without a single new block). A busy slot takes up to {maxQueue} more ads in line.
        The price sets itself: every rental raises it by 20%, every day without one lowers it by 10%,
        never below {formatPiko(market.floorPricePerBlockE8s)} PIKO/block.
      </p>

      <div className="disclaimer disclaimer-strong">
        <strong>Ads are not reviewed by anyone.</strong> They're shown exactly as the advertiser made them,
        with a "not verified" label. Never trust a link just because it's here. Burned PIKO can't be
        refunded, including if your ad turns out to be useless to you.
      </div>

      <div className="board-grid">
        {market.slots.map((s) => {
          const n = Number(s.slot);
          const ad = s.current;
          const mine = ad && ad.advertiser.toText() === me;
          const full = s.queue.length >= maxQueue && !!ad;
          const canPick = !!identity && !full;
          return (
            <div key={n} className="board-cell">
              <button
                type="button"
                className={`board-slot ${slot === n ? "active" : ""} ${ad?.suspicious ? "suspicious" : ""}`}
                onClick={() => canPick && pick(n)}
                disabled={!canPick}
              >
                <span className="stat-label">
                  Slot {n + 1} ·{" "}
                  {ad
                    ? `${mine ? "yours, " : ""}${ad.blocksLeft.toString()} blocks left`
                    : "free"}
                  {s.queue.length > 0 ? ` · ${s.queue.length} waiting` : ""}
                </span>
                {ad ? (
                  <>
                    {ad.suspicious && <span className="board-warning">{SUSPICIOUS_WARNING}</span>}
                    {ad.image && <AdImage image={ad.image} />}
                    {ad.imageHidden && <span className="board-cell-meta">(image hidden after reports)</span>}
                    <span className="board-cell-text">{ad.text}</span>
                    {ad.link && <span className="board-cell-link mono">{ad.link}</span>}
                    <span className="board-cell-meta mono">
                      {shortPrincipal(ad.advertiser.toText())} · {formatPiko(ad.burnedE8s)} PIKO burned
                      {ad.reports > 0n ? ` · ${ad.reports.toString()} report${ad.reports > 1n ? "s" : ""}` : ""}
                    </span>
                  </>
                ) : null}
                <span className="board-cell-text muted">
                  {!identity ? "Log in to rent" : full ? "Waiting list full" : ad ? "Click to join the queue" : "Click to rent"}
                </span>
              </button>
              {identity && ad && !mine && (
                <button
                  type="button"
                  className="board-flag"
                  onClick={() => handleReport(n)}
                  disabled={busy || s.reportedByMe}
                >
                  {s.reportedByMe ? "Reported" : "⚑ Report this ad"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {identity && selected && (
        <form className="board-form" onSubmit={handleRent}>
          <label className="stat-label" htmlFor="board-msg">
            Text ({text.length}/{market.maxTextChars.toString()})
          </label>
          <input
            id="board-msg"
            className="input"
            value={text}
            maxLength={Number(market.maxTextChars)}
            onChange={(e) => setText(e.target.value)}
            placeholder="What should people read?"
            required
          />
          <label className="stat-label" htmlFor="board-url">
            Link (optional, https:// only, shown as plain text in the app)
          </label>
          <input
            id="board-url"
            className="input mono"
            value={link}
            maxLength={Number(market.maxLinkChars)}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://"
          />
          <label className="board-toggle">
            <input type="checkbox" checked={withImage} onChange={(e) => setWithImage(e.target.checked)} /> Add a{" "}
            {IMAGE_WIDTH}x{IMAGE_HEIGHT} pixel image (hidden automatically if the ad gets reported)
          </label>
          {withImage && <ImageEditor value={image} onChange={setImage} />}
          <label className="stat-label" htmlFor="board-blocks">
            Duration: {blocks} block{blocks > 1 ? "s" : ""} ({blocksToDuration(blocks, market.targetBlockSeconds)} at the{" "}
            {Number(market.targetBlockSeconds) / 60}-min target, longer while few people mine)
          </label>
          <input
            id="board-blocks"
            type="range"
            min={minBlocks}
            max={maxBlocks}
            step={1}
            value={blocks}
            onChange={(e) => setBlocks(Number(e.target.value))}
          />
          {waitBlocks > 0n && (
            <p className="wallet-hint">
              This slot is busy: your ad joins the queue and starts after {waitBlocks.toString()} more blocks
              ({blocksToDuration(waitBlocks, market.targetBlockSeconds)} at the target pace).
            </p>
          )}
          <button type="submit" className="button" disabled={busy || text.trim() === ""}>
            {busy
              ? "Burning..."
              : `${waitBlocks > 0n ? "Queue in" : "Rent"} slot ${(slot ?? 0) + 1} -- burn ${formatPiko(cost)} PIKO`}
          </button>
        </form>
      )}
      {message && <p className={`mining-message ${message.kind}`}>{message.text}</p>}

      <p className="wallet-hint">
        Block #{market.currentHeight.toString()} · {market.totalAdRentals.toString()} rentals so far ·{" "}
        {formatPiko(market.totalAdBurnedE8s)} PIKO burned by ads
      </p>
    </section>
  );
}
