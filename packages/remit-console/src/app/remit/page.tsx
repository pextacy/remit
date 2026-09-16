import { Cap, Figure, Hash, Measure, Problem } from "@/components/bits";
import { bundleState, spentToday } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * The Remit itself (CN-4, RM-6): the caps, the five hashes, and what it permits.
 *
 * Expiry is a countdown rather than a timestamp, because the question an operator has is
 * "is this still in force?" and a unix second does not answer it.
 */
export default function RemitScreen() {
  const state = bundleState();

  if (state.kind === "unreadable") {
    return (
      <>
        <div className="head">
          <span className="eyebrow">the remit for {state.network}</span>
          <h1>Unreadable</h1>
          <p className="lede">This Remit is not a Remit.</p>
        </div>
        <section>
          <Problem title={state.problem} detail={state.detail} />
          <p>
            Nothing is acting under it: the bridge refuses to start on a document it
            cannot parse. Reissue it with <code>pnpm --filter ops remit:issue</code>.
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
          <p className="lede">Nothing has been delegated on this network yet.</p>
        </div>
        <section>
          <p>
            Issue one with <code>pnpm --filter ops remit:issue</code>.
          </p>
        </section>
      </>
    );
  }

  const { bundle } = state;
  // The ledger G1 enforces, not a figure derived from the receipts: a screen that shows
  // headroom the gate does not use is a screen an operator plans against wrongly.
  const charged = spentToday();
  const spent = charged.known ? charged.usd : 0;
  const dailyCap = Number(bundle.limits.dailyCapUsd);
  const perTxCap = Number(bundle.limits.perTxCapUsd);
  const reviewAbove = Number(bundle.limits.requireReviewAboveUsd);

  const now = Math.floor(Date.now() / 1000);
  const remaining = bundle.remit.notAfter - now;
  const expired = remaining <= 0;
  const notYet = now < bundle.remit.notBefore;
  const hours = Math.floor(remaining / 3600);
  const expiry = expired
    ? "expired"
    : hours > 48
      ? `${Math.floor(hours / 24)} days`
      : `${hours} hours`;

  return (
    <>
      <div className="head">
        <span className="eyebrow">the unit of delegated authority</span>
        <h1>Remit</h1>
        <p className="lede">
          The document the agent acts under. It can narrow what the on-chain preset
          grants, never widen it — so what is written here is a promise the chain is
          already keeping.
        </p>
      </div>

      {/*
        The caps are the largest thing on this screen, because they are the document. Each
        is drawn out to the remit line, with the review threshold marked where it actually
        falls along it — "a person looks above 1 USD" is a place on this line, not a
        separate fact about it.
      */}
      <section>
        <Cap
          label="the most one action may move"
          value={bundle.limits.perTxCapUsd}
          unit="USD"
        >
          {/*
            Nothing is filled in here, and that is the point: a per-transaction cap has no
            current value to draw. What the track carries is its extent — from nothing to
            the line — and the one place along it where an action stops for a person.
          */}
          <Measure
            amount={0}
            cap={perTxCap}
            mark={{
              at: reviewAbove,
              label: `above ${bundle.limits.requireReviewAboveUsd} USD, a person looks`,
            }}
            left="0"
            right={
              <>
                the line is <strong>{bundle.limits.perTxCapUsd} USD</strong>
              </>
            }
          />
        </Cap>

        <Cap label="and in a rolling day" value={bundle.limits.dailyCapUsd} unit="USD">
          <Measure
            amount={spent}
            cap={dailyCap}
            left={
              <>
                <strong>{spent.toFixed(2)} USD</strong> spent ·{" "}
                {bundle.limits.maxTxPerHour} actions per hour
              </>
            }
            right={
              <>
                <strong>{Math.max(dailyCap - spent, 0).toFixed(2)} USD</strong> left today
              </>
            }
          />
        </Cap>
      </section>

      {charged.known ? null : (
        <section>
          <Problem title="The spend ledger could not be read" detail={charged.problem}>
            <p>
              The day above is drawn as if nothing had been spent — the most generous
              reading, and not a reading at all. G1 refuses rather than guessing, so
              nothing is acting on this number; fix the file before it needs to.
            </p>
          </Problem>
        </section>
      )}

      <section>
        <div className="figures">
          <Figure
            label="in force"
            value={expired ? "no" : notYet ? "not yet" : "yes"}
            sub={expired ? "reissue it rather than widening it" : `expires in ${expiry}`}
            mark={!expired && !notYet}
          />
          <Figure
            label="chain"
            value={bundle.remit.chainId}
            sub={`nonce ${bundle.remit.nonce} — a Remit for one chain authorises nothing on another`}
          />
          <Figure
            label="safe"
            value={<Hash value={bundle.remit.safe} />}
            sub="the authority being delegated from"
          />
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>The five hashes</h2>
          <span className="label">reproducible from the committed documents</span>
        </div>
        <dl className="terms">
          <dt>remitHash</dt>
          <dd>
            <Hash value={bundle.remitHash} />
          </dd>
          <dd className="gloss">the EIP-712 digest, re-derived here rather than read</dd>

          <dt>strategyHash</dt>
          <dd>
            <Hash value={bundle.remit.strategyHash} />
          </dd>
          <dd className="gloss">why the action happened</dd>

          <dt>workflowHash</dt>
          <dd>
            <Hash value={bundle.remit.workflowHash} />
          </dd>
          <dd className="gloss">what exactly runs</dd>

          <dt>limitsHash</dt>
          <dd>
            <Hash value={bundle.remit.limitsHash} />
          </dd>
          <dd className="gloss">how much, where, when</dd>

          <dt>roleKey</dt>
          <dd>
            <Hash value={bundle.remit.roleKey} />
          </dd>
          <dd className="gloss">what is permitted at all</dd>
        </dl>
      </section>

      <section>
        <div className="section-head">
          <h2>What it permits</h2>
          <span className="label">and nothing else is expressible</span>
        </div>
        <dl className="terms">
          <dt>actions</dt>
          <dd>{bundle.limits.allowedIntentKinds.join(", ")}</dd>
          <dd className="gloss">three shapes, and nothing else is expressible</dd>

          <dt>assets</dt>
          <dd>{bundle.limits.allowedAssets.join(", ")}</dd>
          <dd className="gloss">a symbol, never an address a strategy chose</dd>

          <dt>functions</dt>
          <dd>{bundle.limits.allowedSelectors.join("\n")}</dd>
          <dd className="gloss">signatures, so a diff is readable</dd>

          <dt>contracts</dt>
          <dd>{bundle.limits.allowedTargets.join("\n")}</dd>
          <dd className="gloss">the two the preset scopes on chain</dd>

          <dt>value may land at</dt>
          <dd>{bundle.limits.allowedRecipients.join("\n")}</dd>
          <dd className="gloss">
            The Safe, and nothing else. That one line is why exfiltration is not
            expressible rather than merely disallowed.
          </dd>
        </dl>
      </section>
    </>
  );
}
