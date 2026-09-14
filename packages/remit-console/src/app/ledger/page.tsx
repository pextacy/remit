import { Empty, GatePill, Hash } from "@/components/bits";
import { chainIntegrity, explorerFor, loadBundle, loadReceipts } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * The receipt ledger (CN-2, RC-5).
 *
 * Every attempt, in order, with links out to the chain. The integrity line at the top is
 * the point of the page: it is recomputed from the bytes on disk on every load, so a
 * ledger that has been edited says so rather than rendering prettily.
 */
export default function Ledger() {
  const bundle = loadBundle();
  const receipts = loadReceipts();
  const integrity = chainIntegrity();
  const explorer = bundle === undefined ? "" : explorerFor(bundle.deployment.chainId);

  return (
    <>
      <h1>Ledger</h1>
      <p className="lede">
        {integrity.ok ? (
          <span className="ok">
            Chain intact — {integrity.count} receipt(s), every hash re-derived from the
            bytes on disk.
          </span>
        ) : (
          <span className="no">
            {integrity.problems} problem(s). This chain does not prove what it claims.
          </span>
        )}{" "}
        Head <Hash value={integrity.head} />
      </p>

      {receipts.length === 0 ? (
        <Empty>No receipts yet.</Empty>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>action</th>
                <th>outcome</th>
                <th>gates</th>
                <th>transaction</th>
                <th>receipt</th>
              </tr>
            </thead>
            <tbody>
              {[...receipts].reverse().map((receipt) => (
                <tr key={receipt.selfHash}>
                  <td className="mono">{receipt.sequence}</td>
                  <td>
                    {receipt.action?.description ?? (
                      <span className="muted">
                        refused before compilation — {receipt.intent.kind}
                      </span>
                    )}
                    <div className="muted mono" style={{ fontSize: 11.5 }}>
                      {new Date(receipt.at * 1000)
                        .toISOString()
                        .replace("T", " ")
                        .slice(0, 19)}
                      {receipt.action === null ? "" : ` · ${receipt.action.usd} USD`}
                    </div>
                  </td>
                  <td className={receipt.outcome === "executed" ? "ok" : "warn"}>
                    {receipt.outcome}
                  </td>
                  <td className="gatelist">
                    {receipt.gates.map((gate) => (
                      <GatePill
                        key={`${receipt.selfHash}-${gate.gate}`}
                        gate={gate.gate}
                        outcome={gate.outcome}
                        {...(gate.code === undefined ? {} : { code: gate.code })}
                      />
                    ))}
                  </td>
                  <td>
                    {receipt.submission.txHash === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <Hash
                        value={receipt.submission.txHash}
                        href={
                          receipt.submission.explorer ??
                          `${explorer}/tx/${receipt.submission.txHash}`
                        }
                      />
                    )}
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      via {receipt.submission.path}
                    </div>
                  </td>
                  <td>
                    <Hash value={receipt.selfHash} />
                    <div className="muted mono" style={{ fontSize: 11.5 }}>
                      prev {receipt.prevHash.slice(0, 10)}…
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted">
        <code>uv run --directory packages/remit-bridge remit verify</code> does the same
        checking from a terminal, and from a clean clone by somebody who has never seen
        our machines.
      </p>
    </>
  );
}
