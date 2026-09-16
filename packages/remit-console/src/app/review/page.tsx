import { readPending } from "@remit/core";
import { Empty, GateSequence, Hash, Measure, Problem } from "@/components/bits";
import { loadBundle } from "@/lib/data";
import { consoleToken } from "@/lib/operator";
import { REVIEW_ROOT } from "@/lib/paths";
import { submitDecision } from "./actions";

export const dynamic = "force-dynamic";

/**
 * G3 — the only gate whose cost is a person's attention (CN-1, G3-1, G3-2).
 *
 * What is shown is the decoded action in named parameters: the contract, the function,
 * where value lands, and how much. Never raw calldata. An operator asked to approve a hex
 * blob is an operator being asked to rubber-stamp, and a gate that produces
 * rubber-stamping is worse than no gate, because it launders the decision.
 */
export default async function Review({
  searchParams,
}: {
  searchParams: Promise<{ refused?: string }>;
}) {
  const pending = readPending(REVIEW_ROOT);
  const bundle = loadBundle();
  const perTxCap = Number(bundle?.limits.perTxCapUsd ?? 0);
  const refused = (await searchParams).refused;
  // Set only when the operator has deliberately put this console somewhere other than
  // their own machine. Then every decision has to carry it, and the field says so.
  const needsToken = consoleToken() !== "";

  return (
    <>
      <div className="head">
        <span className="eyebrow">g3 · the gate that costs a person</span>
        <h1>Review</h1>
        <p className="lede">
          Actions above the Remit&apos;s review threshold wait here. G1 and G2 have
          already agreed; this is the gate that costs a person&apos;s attention.
        </p>
      </div>

      {refused === undefined ? null : (
        <section>
          <Problem title="That decision was not recorded" detail={refused} />
        </section>
      )}

      {pending.length === 0 ? (
        <section>
          <Empty>
            Nothing waiting. An action above the threshold stops here — run one with{" "}
            <code>pnpm --filter ops propose --review</code>.
          </Empty>
        </section>
      ) : (
        pending.map((item) => (
          <section key={item.id}>
            <div className="section-head">
              <span className="label">waiting for a decision</span>
              <span className="label">
                {new Date(item.at * 1000).toISOString().replace("T", " ").slice(0, 16)}
              </span>
            </div>

            <h2>{item.action.description}</h2>

            {/* Why this one stopped. The reviewer's first question, answered first. */}
            <p className="lede" style={{ margin: "12px 0 24px" }}>
              {item.reason}.
            </p>

            <Measure
              amount={Number(item.action.usd)}
              cap={perTxCap}
              left={
                <>
                  <strong>{item.action.usd} USD</strong> · {perTxCap} USD per transaction
                </>
              }
              right={
                <>
                  approving leaves <strong>{item.headroomUsd} USD</strong> of headroom
                  today
                </>
              }
            />

            <GateSequence gates={item.gates} />

            <dl className="terms">
              <dt>function</dt>
              <dd>{item.action.signature}</dd>
              <dd className="gloss">{item.action.selector}</dd>

              <dt>contract</dt>
              <dd>{item.action.target}</dd>
              <dd className="gloss">the only contracts the role may call at all</dd>

              <dt>intent</dt>
              <dd>{JSON.stringify(item.intent)}</dd>
              <dd className="gloss">typed, never calldata</dd>

              <dt>remit</dt>
              <dd>
                <Hash value={item.remitHash} />
              </dd>
              <dd className="gloss">the authority this would happen under</dd>

              {item.balanceDelta === undefined ? null : (
                <>
                  <dt>the safe would hold</dt>
                  <dd>
                    {item.balanceDelta.usdc} USDC — {item.balanceDelta.note}
                  </dd>
                  <dd className="gloss">
                    Simulated against current state — the check on whether the call does
                    what its name says.
                  </dd>
                </>
              )}
            </dl>

            <form className="controls" action={submitDecision}>
              <input type="hidden" name="id" value={item.id} />

              {needsToken ? (
                <label className="field">
                  <span className="label">operator token</span>
                  <input type="password" name="token" autoComplete="off" required />
                </label>
              ) : null}

              <label className="field">
                <span className="label">who is deciding</span>
                <input type="text" name="by" defaultValue="operator" />
              </label>

              <label className="field" style={{ flex: 1, minWidth: 220 }}>
                <span className="label">note</span>
                <input type="text" name="note" placeholder="optional" />
              </label>

              <button name="decision" value="approved" type="submit">
                Approve
              </button>
              <button name="decision" value="declined" type="submit">
                Decline
              </button>
            </form>
          </section>
        ))
      )}
    </>
  );
}
