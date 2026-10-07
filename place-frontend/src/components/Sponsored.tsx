import { useCallback, useEffect, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getPlaceActor, getLedgerActor } from "../lib/actors";
import { placeCanisterId } from "../lib/canister-env";
import { formatPiko, shortPrincipal, timeUntil } from "../lib/format";
import { ReportAdError, type Ad, type AdMarket, type RentAdError } from "../bindings/place/place";

// Shown next to every ad, everywhere ads appear (this site, the browser
// mining site, PikoNativeMiner): nobody reviews these, by design.
export const AD_DISCLAIMER = "Sponsored · not verified by PIKO · do your own research";

const POLL_MS = 10_000;
const ROTATE_MS = 8_000;
const PIKO_LEDGER_FEE_E8S = 10_000n; // same gotcha as Canvas.tsx's approve flow

const placePrincipal = Principal.fromText(placeCanisterId);

function rentErrorMessage(err: RentAdError): string {
  switch (err.__kind__) {
    case "Anonymous":
      return "Log in to rent a slot.";
    case "TooSoon":
      return "Slow down a little -- try again in a moment.";
    case "InvalidSlot":
      return "That slot doesn't exist.";
    case "SlotTaken":
      return `That slot is taken for another ${timeUntil(err.SlotTaken.expiresAt)}.`;
    case "SlotBusy":
      return "Someone is renting that slot right now -- try again in a few seconds.";
    case "InvalidText":
      return "Text must be 1-80 characters, on one line.";
    case "InvalidLink":
      return "Link must start with https:// and contain no spaces or special characters.";
    case "InvalidDuration":
      return "Pick between 1 and 7 days.";
    case "ExtensionTooLong":
      return "An ad can't run more than 7 days ahead -- pick fewer days.";
    case "PriceAboveMax":
      return `The price just changed to ${formatPiko(err.PriceAboveMax.pricePerDayE8s)} PIKO/day -- check it and try again.`;
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
      return "That ad already expired.";
    default:
      return "Couldn't report that ad.";
  }
}

export const SUSPICIOUS_WARNING = "⚠ Reported as suspicious by several players -- be extra careful";

/** Rotating one-line banner of the ads currently running. Renders nothing when there are none. */
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
  const [fetchedAt, setFetchedAt] = useState(0);
  const [slot, setSlot] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  const [days, setDays] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "good" | "critical"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMarket(await getPlaceActor().getAdMarket());
      setFetchedAt(Date.now());
    } catch (err) {
      console.error("Failed to load ad market", err);
    }
  }, []);

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
  // A slot is selectable when it's free, or when it's the caller's own
  // running ad (renting it again extends it).
  const selectable = market.slots.filter((s) => !s.ad || s.ad.advertiser.toText() === me);
  const selected = market.slots.find((s) => Number(s.slot) === slot) ?? null;
  const isExtension = !!selected?.ad;
  // An extension starts where the running ad ends, and the canister caps
  // an ad at maxDays ahead of now -- so only the days left under that cap.
  const maxDays = selected?.ad
    ? Math.max(
        0,
        Math.floor(
          (Number(market.maxDays) * 86_400_000 - (Number(selected.ad.expiresAt / 1_000_000n) - fetchedAt)) /
            86_400_000,
        ),
      )
    : Number(market.maxDays);
  const price = market.pricePerDayE8s;
  const cost = price * BigInt(days);

  function pick(n: number) {
    setSlot(n);
    setDays(1);
    setMessage(null);
    const own = market?.slots.find((s) => Number(s.slot) === n)?.ad;
    setText(own?.text ?? "");
    setLink(own?.link ?? "");
  }

  async function handleReport(n: number) {
    if (!identity) return;
    if (!window.confirm(`Report the ad in slot ${n + 1} as a scam or abusive? It adds a public warning once several players report it.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await getPlaceActor(identity).reportAd(BigInt(n));
      if (result.__kind__ === "Ok") {
        setMessage({
          kind: "good",
          text: result.Ok.suspicious
            ? "Reported -- this ad is now shown with a warning everywhere."
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
        BigInt(days),
        price,
      );
      if (result.__kind__ === "Ok") {
        setMessage({
          kind: "good",
          text: `Done -- ${formatPiko(cost)} PIKO burned, your ad runs for ${timeUntil(result.Ok.expiresAt)}.`,
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
        <span className="dice-edge-pill">{formatPiko(price)} PIKO / day, burned</span>
      </div>
      <p className="section-intro">
        Rent one of {market.slots.length} text slots shown on PikoPixel, the PIKO mining site and the
        PikoNativeMiner app. You pay by burning PIKO, same as a pixel. The price sets itself: every
        rental raises it by 20%, every day without one lowers it by 10%, never below{" "}
        {formatPiko(market.floorPricePerDayE8s)} PIKO/day.
      </p>

      <div className="disclaimer disclaimer-strong">
        <strong>Ads are not reviewed by anyone.</strong> They're shown exactly as the advertiser wrote
        them, with a "not verified" label. Never trust a link just because it's here. Burned PIKO can't
        be refunded, including if your ad turns out to be useless to you.
      </div>

      <div className="board-grid">
        {market.slots.map((s) => {
          const n = Number(s.slot);
          const mine = s.ad && s.ad.advertiser.toText() === me;
          const canPick = !!identity && (!s.ad || mine);
          return (
            <div key={n} className="board-cell">
              <button
                type="button"
                className={`board-slot ${slot === n ? "active" : ""} ${s.ad ? "taken" : "free"} ${s.ad?.suspicious ? "suspicious" : ""}`}
                onClick={() => canPick && pick(n)}
                disabled={!canPick}
              >
                <span className="stat-label">
                  Slot {n + 1} · {s.ad ? `${mine ? "yours, " : ""}${timeUntil(s.ad.expiresAt)} left` : "free"}
                </span>
                {s.ad ? (
                  <>
                    {s.ad.suspicious && <span className="board-warning">{SUSPICIOUS_WARNING}</span>}
                    <span className="board-cell-text">{s.ad.text}</span>
                    {s.ad.link && <span className="board-cell-link mono">{s.ad.link}</span>}
                    <span className="board-cell-meta mono">
                      {shortPrincipal(s.ad.advertiser.toText())} · {formatPiko(s.ad.burnedE8s)} PIKO burned
                      {s.ad.reports > 0n ? ` · ${s.ad.reports.toString()} report${s.ad.reports > 1n ? "s" : ""}` : ""}
                    </span>
                  </>
                ) : (
                  <span className="board-cell-text muted">{identity ? "Click to rent" : "Log in to rent"}</span>
                )}
              </button>
              {identity && s.ad && !mine && (
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

      {identity && selectable.length === 0 && (
        <p className="wallet-hint">All slots are taken right now -- check back when one expires.</p>
      )}

      {identity && selected && maxDays === 0 && (
        <p className="wallet-hint">Your ad already runs the maximum {market.maxDays.toString()} days ahead -- extend it later.</p>
      )}

      {identity && selected && maxDays > 0 && (
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
          <label className="stat-label" htmlFor="board-days">
            {isExtension ? "Extend by" : "Duration"}: {days} day{days > 1 ? "s" : ""}
          </label>
          <input
            id="board-days"
            type="range"
            min={1}
            max={maxDays}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          />
          <button type="submit" className="button" disabled={busy || text.trim() === ""}>
            {busy
              ? "Burning..."
              : `${isExtension ? "Extend" : "Rent"} slot ${(slot ?? 0) + 1} -- burn ${formatPiko(cost)} PIKO`}
          </button>
        </form>
      )}
      {message && <p className={`mining-message ${message.kind}`}>{message.text}</p>}

      <p className="wallet-hint">
        {market.totalAdRentals.toString()} rentals so far · {formatPiko(market.totalAdBurnedE8s)} PIKO
        burned by ads
      </p>
    </section>
  );
}
