import { useCallback, useEffect, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getPlaceActor, getLedgerActor } from "./lib/actors";
import { login, logout, getStoredIdentity } from "./lib/auth";
import { formatPiko, parseAmount, shortPrincipal, timeAgo } from "./lib/format";
import { Canvas } from "./components/Canvas";
import type { Stats, RecentPlacement } from "./bindings/place/place";
import "./App.css";

const POLL_MS = 2000;

interface PainterEntry {
  player: string;
  placements: number;
}

function paintersFromRecent(recent: RecentPlacement[]): PainterEntry[] {
  const counts = new Map<string, number>();
  for (const p of recent) {
    const key = p.player.toText();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([player, placements]) => ({ player, placements }))
    .sort((a, b) => b.placements - a.placements)
    .slice(0, 10);
}

function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [recent, setRecent] = useState<RecentPlacement[]>([]);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<string | null>(null);

  useEffect(() => {
    getStoredIdentity().then((id) => setIdentity(id));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const place = getPlaceActor();
      const [s, r] = await Promise.all([place.getStats(), place.getRecentPlacements()]);
      setStats(s);
      setRecent(r.slice().reverse());
    } catch (err) {
      console.error("Failed to refresh place stats", err);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polling on-chain state, not derived
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const refreshBalance = useCallback(async (id: Identity) => {
    try {
      const raw = await getLedgerActor(id).icrc1_balance_of({ owner: id.getPrincipal() });
      setBalance(raw as unknown as bigint);
    } catch (err) {
      console.error("Failed to fetch PIKO balance", err);
    }
  }, []);

  useEffect(() => {
    if (identity) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with the ledger, not derived state
      refreshBalance(identity);
    } else {
      setBalance(null);
    }
  }, [identity, refreshBalance]);

  const handlePlaced = useCallback(() => {
    refresh();
    if (identity) refreshBalance(identity);
  }, [refresh, refreshBalance, identity]);

  async function handleLogin() {
    const id = await login();
    setIdentity(id);
  }

  async function handleLogout() {
    await logout();
    setIdentity(null);
  }

  async function handleCopyPrincipal() {
    if (!identity) return;
    await navigator.clipboard.writeText(identity.getPrincipal().toText());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!identity) return;
    const raw = parseAmount(sendAmount);
    if (raw === null || raw <= 0n) {
      setSendStatus("Enter a valid amount.");
      return;
    }
    let to: Principal;
    try {
      to = Principal.fromText(sendTo.trim());
    } catch {
      setSendStatus("That's not a valid principal.");
      return;
    }
    setSending(true);
    setSendStatus(null);
    try {
      const result = await getLedgerActor(identity).icrc1_transfer({ to: { owner: to }, amount: raw });
      if ("Ok" in result) {
        setSendStatus(`Sent ${formatPiko(raw)} PIKO.`);
        setSendTo("");
        setSendAmount("");
        refreshBalance(identity);
      } else {
        setSendStatus(`Failed: ${JSON.stringify(result.Err)}`);
      }
    } catch (err) {
      console.error("Send failed", err);
      setSendStatus("Send failed, try again.");
    } finally {
      setSending(false);
    }
  }

  const painters = paintersFromRecent(recent);

  return (
    <main className="page">
      <header className="header">
        <div className="brand">
          <span className="section-icon" style={{ fontSize: "1.4rem" }}>
            &#127912;
          </span>
          <div className="brand-text">
            <span className="brand-name">PikoPlace</span>
            <span className="brand-ticker">
              {stats ? (
                <>
                  <span className="pulse-dot" /> {stats.totalPlacements.toString()} pixels placed, live
                </>
              ) : (
                "A collaborative canvas · fully on-chain"
              )}
            </span>
          </div>
        </div>
        <div className="wallet-box">
          {identity ? (
            <>
              <span className="principal-pill">
                {shortPrincipal(identity.getPrincipal().toText())}
                {balance !== null ? ` · ${formatPiko(balance)} PIKO` : ""}
              </span>
              <button type="button" className="button secondary small" onClick={handleCopyPrincipal}>
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                className="button secondary small"
                onClick={() => setShowSend((s) => !s)}
              >
                Send out
              </button>
              <button className="button secondary" onClick={handleLogout}>
                Log out
              </button>
            </>
          ) : (
            <button className="button" onClick={handleLogin}>
              Log in with Internet Identity
            </button>
          )}
        </div>
      </header>

      {identity && (
        <div className="wallet-address-row">
          <code className="wallet-address">{identity.getPrincipal().toText()}</code>
        </div>
      )}
      {identity && (
        <p className="wallet-hint">
          This principal is specific to PikoPlace -- Internet Identity derives a different one per
          site, so PIKO held on the mining/dice/blackjack sites isn't here automatically. Send PIKO to
          the address above (from PikoPay, an exchange, or another wallet) before approving.
        </p>
      )}
      {identity && showSend && (
        <form className="wallet-send-row" onSubmit={handleSend}>
          <input
            className="input"
            placeholder="Recipient principal"
            value={sendTo}
            onChange={(e) => setSendTo(e.target.value)}
          />
          <input
            className="input"
            placeholder="Amount (PIKO)"
            value={sendAmount}
            onChange={(e) => setSendAmount(e.target.value)}
            inputMode="decimal"
          />
          <button type="submit" className="button secondary small" disabled={sending}>
            {sending ? "Sending..." : "Send"}
          </button>
        </form>
      )}
      {sendStatus && <p className="wallet-status">{sendStatus}</p>}

      <div className="disclaimer">
        <strong>This isn't a bet -- it's a burn.</strong> Every pixel permanently destroys a small
        amount of PIKO (sent straight to the ledger's minting account), same as any other ICRC-1 burn.
        There's no payout, no bankroll, and no way to get it back -- only place with what you're happy
        to see gone for good, as your contribution to a shared piece of art.
      </div>

      <section className="hero">
        <div className="tag-row">
          <span className="tag">Community canvas</span>
          <span className="tag">PIKO burned, not bet</span>
          <span className="tag spark">100% on-chain</span>
        </div>
        <h1>Paint a pixel. &#127912; Burn some PIKO.</h1>
        <p>
          A companion to PIKO -- not a game, a shared canvas. Every placement is a tiny, permanent
          deflationary event, visible to everyone in real time. Independent build, not affiliated with
          r/place or any other canvas site.
        </p>
      </section>

      <Canvas identity={identity} onPlaced={handlePlaced} />

      <section className="block story-block">
        <h2>
          How it works <span className="section-icon">⚙️</span>
        </h2>
        <ul className="tech-list">
          <li>
            A shared {stats ? stats.gridSize.toString() : "100"}x{stats ? stats.gridSize.toString() : "100"} grid,
            one canister, every pixel visible to every visitor -- refreshed live, no login needed just
            to look.
          </li>
          <li>
            Placing a pixel pulls a fixed amount of PIKO from your own balance (you approve it once)
            and sends it directly to the PIKO ledger's own minting account -- a real ICRC-1 burn,
            permanently removed from total supply.
          </li>
          <li>
            <strong>This canister never holds the PIKO, even briefly.</strong> Unlike every game in
            this family, there's no bankroll and no withdrawal path here, because there's nothing left
            to withdraw once a pixel is placed -- it's gone, by design.
          </li>
          <li>No backend, no database, nothing off-chain -- same as the rest of PIKO.</li>
        </ul>
      </section>

      <section className="block">
        <h2 className="spark">
          Stats <span className="section-icon">🔥</span>
        </h2>
        {stats ? (
          <div className="stat-grid">
            <div className="stat-tile">
              <div className="stat-label token-label">
                <img src="/piko-logo.svg" alt="" className="token-icon" />
                Pixels placed
              </div>
              <div className="stat-value">{stats.totalPlacements.toString()}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label token-label">
                <img src="/piko-logo.svg" alt="" className="token-icon" />
                Distinct painters
              </div>
              <div className="stat-value">{stats.distinctPainters.toString()}</div>
            </div>
            <div className="stat-tile stat-tile-wide">
              <div className="stat-label token-label">
                <img src="/piko-logo.svg" alt="" className="token-icon" />
                PIKO burned, total
              </div>
              <div className="stat-value">{formatPiko(stats.totalBurnedPiko)}</div>
            </div>
          </div>
        ) : (
          <div className="empty-state">Loading canvas stats...</div>
        )}
      </section>

      <section className="block">
        <h2>
          Top painters <span className="section-icon">🏆</span>
        </h2>
        <p className="section-intro">Ranked by placements among the most recent activity below.</p>
        {painters.length > 0 ? (
          <div className="table-scroll">
            <table className="blocks">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Painter</th>
                  <th>Pixels placed</th>
                </tr>
              </thead>
              <tbody>
                {painters.map((entry, i) => (
                  <tr key={entry.player}>
                    <td className={i < 3 ? `rank-${i + 1}` : ""}>{i + 1}</td>
                    <td className="mono">{shortPrincipal(entry.player)}</td>
                    <td>{entry.placements}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">No one's painted yet -- be the first.</div>
        )}
      </section>

      <section className="block">
        <div className="miner-panel-head">
          <h2 className="spark">
            Recent placements <span className="section-icon">&#127912;</span>
          </h2>
          {recent.length > 0 && (
            <span className="live-pill">
              <span className="live-dot" /> live feed
            </span>
          )}
        </div>
        {recent.length > 0 ? (
          <div className="table-scroll">
            <table className="blocks">
              <thead>
                <tr>
                  <th>Painter</th>
                  <th>Cell</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((p, i) => (
                  <tr key={i}>
                    <td className="mono">{shortPrincipal(p.player.toText())}</td>
                    <td>
                      ({p.x.toString()}, {p.y.toString()})
                    </td>
                    <td>{timeAgo(p.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">No placements yet.</div>
        )}
      </section>

      <footer className="footer">
        <p>
          PikoPlace is open-source and entirely hosted on the Internet Computer -- no servers, no
          database. Same non-affiliation note as the rest of PIKO: an independent, original build.
        </p>
      </footer>
    </main>
  );
}

export default App;
