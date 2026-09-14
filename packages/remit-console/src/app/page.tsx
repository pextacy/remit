import Link from "next/link";
import { Empty, Hash, Stat } from "@/components/bits";
import {
  chainIntegrity,
  gateCounters,
  loadBundle,
  loadReceipts,
  spentTodayUsd,
} from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * The overview: the four gates as counters, and whether the chain of receipts still
 * verifies (CN-5, RC-5).
 *
 * Refusals are shown next to attempts on purpose. A system whose refusal count is zero
 * has either never been tested or is not refusing anything, and both are worth noticing
 * at a glance.
 */
export default function Overview() {
  const bundle = loadBundle();
  const receipts = loadReceipts();
  const counters = gateCounters(receipts);
  const integrity = chainIntegrity();
  const spent = spentTodayUsd(receipts);

  if (bundle === undefined) {
    return (
      <>
        <h1>No Remit for this network</h1>
        <p className="lede">
          Issue one with <code>pnpm --filter ops remit:issue</code>, or point the console
          at another network with <code>REMIT_NETWORK</code>.
        </p>
      </>
    );
  }

  const cap = Number(bundle.limits.dailyCapUsd);

  return (
    <>
      <h1>Overview</h1>
      <p className="lede">
        Safe <Hash value={bundle.remit.safe} /> · Remit <Hash value={bundle.remitHash} />
      </p>

      <div className="grid">
        {(["G1", "G2", "G3", "G4"] as const).map((gate) => (
          <Stat
            key={gate}
            label={`${gate} ${
              { G1: "envelope", G2: "preflight", G3: "review", G4: "chain" }[gate]
            }`}
            value={counters[gate].attempts}
            sub={`${counters[gate].refused} refused`}
            {...(counters[gate].refused > 0 ? { tone: "warn" as const } : {})}
          />
        ))}
      </div>

      <h2>Today</h2>
      <div className="grid">
        <Stat
          label="spent"
          value={`${spent.toFixed(2)} USD`}
          sub={`of ${bundle.limits.dailyCapUsd} daily cap`}
          {...(spent >= cap ? { tone: "no" as const } : {})}
        />
        <Stat
          label="headroom"
          value={`${Math.max(cap - spent, 0).toFixed(2)} USD`}
          sub={`per transaction: ${bundle.limits.perTxCapUsd} USD`}
        />
        <Stat
          label="receipts"
          value={integrity.count}
          sub={integrity.ok ? "chain intact" : `${integrity.problems} problem(s)`}
          tone={integrity.ok ? "ok" : "no"}
        />
        <Stat
          label="chain head"
          value={<Hash value={integrity.head} />}
          sub="every hash re-derived from the bytes on disk"
        />
      </div>

      {receipts.length === 0 ? (
        <Empty>
          No receipts yet. Run <code>pnpm --filter ops propose</code> and this fills in.
        </Empty>
      ) : (
        <>
          <h2>Latest</h2>
          <div className="panel">
            <table>
              <tbody>
                {receipts
                  .slice(-5)
                  .reverse()
                  .map((receipt) => (
                    <tr key={receipt.selfHash}>
                      <td className="mono">#{receipt.sequence}</td>
                      <td>{receipt.action?.description ?? receipt.intent.kind}</td>
                      <td className={receipt.outcome === "executed" ? "ok" : "warn"}>
                        {receipt.outcome}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <p className="muted" style={{ marginBottom: 0, marginTop: 12 }}>
              <Link href="/ledger">The whole ledger →</Link>
            </p>
          </div>
        </>
      )}
    </>
  );
}
