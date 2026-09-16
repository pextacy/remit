import { Empty, Figure, Hash, Measure, Problem, Record } from "@/components/bits";
import {
  bundleState,
  chainIntegrity,
  gateCounters,
  loadReceiptsAndProblems,
  proposedUsd,
  spentToday,
  wasRefused,
} from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * The overview: how much of today's remit is gone, what the four gates have been doing,
 * and the last few attempts (CN-5, RC-5).
 *
 * Refusals are shown beside attempts on purpose. A system whose refusal count is zero has
 * either never been tested or is not refusing anything, and both are worth noticing from
 * the doorway.
 */
export default function Overview() {
  const state = bundleState();

  // A Remit that was never issued and one whose file no longer parses are different
  // facts. Showing the getting-started page for the second would tell the one operator
  // who needs to know something is wrong that everything is fine.
  if (state.kind === "unreadable") {
    return (
      <>
        <div className="head">
          <span className="eyebrow">the remit for {state.network}</span>
          <h1>Unreadable</h1>
          <p className="lede">The Remit for this network is not a Remit.</p>
        </div>
        <section>
          <Problem title={state.problem} detail={state.detail} />
          <p>
            Nothing is running under it — the bridge refuses to start on the same
            document. Reissue it with <code>pnpm --filter ops remit:issue</code>, or
            restore the file.
          </p>
        </section>
      </>
    );
  }

  if (state.kind === "missing") {
    return (
      <>
        <div className="head">
          <span className="eyebrow">nothing delegated on {state.network}</span>
          <h1>No Remit</h1>
          <p className="lede">
            Nothing has been delegated on this network yet, so there is nothing to bound
            and nothing to show.
          </p>
        </div>
        <section>
          <Empty>
            Issue one with <code>pnpm --filter ops remit:issue</code>, or point the
            console at another network with <code>REMIT_NETWORK</code>.
          </Empty>
        </section>
      </>
    );
  }

  const { bundle } = state;
  const { receipts, unreadable } = loadReceiptsAndProblems();
  const counters = gateCounters(receipts);
  const integrity = chainIntegrity();

  // The ledger the gate enforces, not a figure derived from the receipts. They are
  // different histories, and this is the number an operator would act on.
  const charged = spentToday();
  const spent = charged.known ? charged.usd : 0;
  const dailyCap = Number(bundle.limits.dailyCapUsd);
  const perTxCap = Number(bundle.limits.perTxCapUsd);
  const headroom = Math.max(dailyCap - spent, 0);

  const latest = [...receipts].slice(-5).reverse();

  return (
    <>
      <div className="head">
        <span className="eyebrow">the four gates, and what is left of today</span>
        <h1>Overview</h1>
        <p className="lede">
          What the agent is permitted to do today, what it has done, and where each
          attempt stopped.
        </p>
      </div>

      {charged.known ? null : (
        <Problem
          title="The spend ledger could not be read, so today's headroom is unknown"
          detail={charged.problem}
        >
          <p>
            Every figure below that mentions the day is drawn as if nothing had been
            spent, which is the most generous reading and not a reading at all. The gate
            itself refuses rather than guessing.
          </p>
        </Problem>
      )}

      {unreadable.length === 0 ? null : (
        <Problem
          title={`${unreadable.length} receipt file(s) could not be read`}
          detail={unreadable.join(", ")}
        >
          <p>They are counted in no figure on this page.</p>
        </Problem>
      )}

      {/* The one measure that answers the question an operator actually arrives with. */}
      <section>
        <div className="section-head">
          <span className="label">Spent today, against the daily cap</span>
          <span className="label">cap {bundle.limits.dailyCapUsd} USD</span>
        </div>
        <Measure
          amount={spent}
          cap={dailyCap}
          left={
            <>
              <strong>{spent.toFixed(2)} USD</strong> spent
            </>
          }
          right={
            <>
              <strong>{headroom.toFixed(2)} USD</strong> headroom · {perTxCap} USD per
              transaction
            </>
          }
        />
      </section>

      <section>
        <div className="section-head">
          <span className="label">The four gates</span>
          <span className="label">attempts · refused</span>
        </div>
        <div className="figures" data-inside="true">
          <Figure
            label="G1 envelope"
            value={counters.G1.attempts}
            sub={`${counters.G1.refused} refused · free, before any I/O`}
          />
          <Figure
            label="G2 preflight"
            value={counters.G2.attempts}
            sub={`${counters.G2.refused} refused · one eth_call, no gas`}
          />
          <Figure
            label="G3 review"
            value={counters.G3.attempts}
            sub={`${counters.G3.refused} refused · a person's attention`}
          />
          <Figure
            label="G4 chain"
            value={counters.G4.attempts}
            sub={`${counters.G4.refused} refused · unforgeably`}
          />
        </div>
      </section>

      <section>
        <div className="section-head">
          <span className="label">The receipt chain</span>
          <span className="label">re-derived on this page load</span>
        </div>
        <div className="figures">
          <Figure
            label="records"
            value={integrity.count}
            sub={
              integrity.ok
                ? "every hash re-derived from the bytes on disk"
                : `${integrity.problems} problem(s) — see the ledger`
            }
            mark={integrity.ok}
          />
          <Figure
            label="head"
            value={<Hash value={integrity.head} />}
            sub="what the whole chain hangs from"
          />
          <Figure
            label="strategy"
            value={<Hash value={bundle.remit.strategyHash} />}
            sub="the version every receipt names"
          />
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>Latest attempts</h2>
          <span className="label">
            measured against {bundle.limits.perTxCapUsd} USD per transaction
          </span>
        </div>

        {latest.length === 0 ? (
          <Empty>
            Nothing has been proposed yet. Run{" "}
            <code>pnpm --filter ops propose --network {bundle.network}</code> and this
            fills in.
          </Empty>
        ) : (
          <div className="records">
            {latest.map((receipt) => {
              const refused = wasRefused(receipt.outcome);
              const usd = proposedUsd(receipt);
              return (
                <Record
                  key={receipt.selfHash}
                  sequence={receipt.sequence}
                  what={
                    receipt.action?.description ??
                    (receipt.intent.kind === "unparseable"
                      ? "what was sent was not an intent"
                      : `${receipt.intent.kind} — refused before compilation`)
                  }
                  gates={receipt.gates}
                  outcome={receipt.outcome}
                  cap={perTxCap}
                  refused={refused}
                  {...(usd === undefined ? {} : { amount: usd })}
                  {...(receipt.action === null
                    ? {
                        detail: (
                          <span>
                            {usd === undefined
                              ? "nothing measurable was proposed"
                              : `${usd} USD proposed · no call was built`}
                          </span>
                        ),
                      }
                    : {})}
                />
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
