import { Empty, Hash, Problem, Record } from "@/components/bits";
import {
  chainIntegrity,
  explorerFor,
  loadBundle,
  loadReceiptsAndProblems,
  proposedUsd,
  wasRefused,
} from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * The ledger: every attempt, in order, including the ones that were refused (CN-2, RC-5).
 *
 * The integrity line at the top is the point of the screen. It is recomputed from the
 * bytes on disk on every load, so a chain that has been edited says so rather than
 * rendering prettily — and when it has been, the whole screen inverts. A log that only
 * contains what worked is a log that has been edited.
 */
export default function Ledger() {
  const bundle = loadBundle();
  const { receipts, unreadable } = loadReceiptsAndProblems();
  const integrity = chainIntegrity();

  const explorer = bundle === undefined ? "" : explorerFor(bundle.deployment.chainId);
  const perTxCap = Number(bundle?.limits.perTxCapUsd ?? 0);
  const broken = !integrity.ok;

  return (
    <div {...(broken ? { "data-inverted": "true" } : {})}>
      <div className="head">
        <span className="eyebrow">every attempt, including every refusal</span>
        <h1>Ledger</h1>
        <p className="lede">
          {broken
            ? "This chain does not prove what it claims. Every figure below is suspect until the records agree again."
            : "Every attempt, in the order it happened, with the hash that links each record to the one before it."}
        </p>
      </div>

      <section>
        <div className="section-head">
          <span className="label">
            {integrity.count} record(s) ·{" "}
            {broken ? `${integrity.problems} problem(s)` : "chain intact"}
            {integrity.underEarlierRemits === 0
              ? null
              : ` · ${integrity.underEarlierRemits} under an earlier Remit`}
          </span>
          <span className="label">
            head <Hash value={integrity.head} />
          </span>
        </div>

        {integrity.detail.length === 0 ? null : (
          <Problem title="The chain does not verify">
            <table>
              <tbody>
                {integrity.detail.map((problem) => (
                  <tr key={`${problem.file}-${problem.problem}`}>
                    <td style={{ whiteSpace: "nowrap" }}>{problem.file}</td>
                    <td>{problem.problem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Problem>
        )}

        {unreadable.length === 0 ? null : (
          <Problem
            title={`${unreadable.length} file(s) here are not receipts`}
            detail={unreadable.join(", ")}
          />
        )}

        {receipts.length === 0 ? (
          <Empty>
            No attempts yet. Every one of them will be recorded here, including the ones
            that are refused.
          </Empty>
        ) : (
          <>
            <div className="columns">
              <span className="label">seq</span>
              <span className="label">action, measured against {perTxCap} USD</span>
              <span className="label">gates</span>
              <span className="label">outcome</span>
            </div>
            <div className="records">
              {[...receipts].reverse().map((receipt) => {
                const refused = wasRefused(receipt.outcome);
                const usd = proposedUsd(receipt);
                const when = new Date(receipt.at * 1000)
                  .toISOString()
                  .replace("T", " ")
                  .slice(0, 19);

                return (
                  <Record
                    key={receipt.selfHash}
                    sequence={receipt.sequence}
                    what={
                      receipt.action?.description ??
                      (receipt.intent.kind === "unparseable" ? (
                        <>
                          what was sent was not an intent
                          <span className="mono quiet"> {receipt.intent.raw}</span>
                        </>
                      ) : (
                        `${receipt.intent.kind} — refused before compilation`
                      ))
                    }
                    gates={receipt.gates}
                    outcome={receipt.outcome}
                    cap={perTxCap}
                    refused={refused}
                    {...(usd === undefined ? {} : { amount: usd })}
                    detail={
                      <>
                        <span>{when}</span>
                        {receipt.action === null ? (
                          <span>
                            {usd === undefined
                              ? "nothing measurable was proposed"
                              : `${usd} USD proposed · no call was built`}
                          </span>
                        ) : (
                          <span>{receipt.action.usd} USD</span>
                        )}
                        <span>via {receipt.submission.path}</span>
                        {receipt.submission.txHash === null ? null : (
                          <Hash
                            value={receipt.submission.txHash}
                            href={
                              receipt.submission.explorer ??
                              `${explorer}/tx/${receipt.submission.txHash}`
                            }
                          />
                        )}
                        <span>
                          record <Hash value={receipt.selfHash} />
                        </span>
                      </>
                    }
                  />
                );
              })}
            </div>
          </>
        )}
      </section>

      <section>
        <p className="lede">
          <code>uv run --directory packages/remit-bridge remit verify</code> re-derives
          every hash here from a terminal, and from a clean clone by somebody who has
          never seen our machines.
        </p>
      </section>
    </div>
  );
}
