import { Hash, Stat } from "@/components/bits";
import { loadBundle, loadReceipts, spentTodayUsd } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * The Remit screen (CN-4, RM-6): the hashes, the limits, what is left, and when it stops.
 *
 * Expiry is shown as a countdown rather than a timestamp because the question an operator
 * has is "is this still in force?", and a unix second does not answer it.
 */
export default function RemitScreen() {
  const bundle = loadBundle();
  if (bundle === undefined) {
    return (
      <>
        <h1>No Remit</h1>
        <p className="lede">
          Issue one with <code>pnpm --filter ops remit:issue</code>.
        </p>
      </>
    );
  }

  const receipts = loadReceipts();
  const spent = spentTodayUsd(receipts);
  const cap = Number(bundle.limits.dailyCapUsd);
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
      <h1>Remit</h1>
      <p className="lede">
        The document the agent acts under. It can narrow what the on-chain preset grants,
        never widen it.
      </p>

      <div className="grid">
        <Stat
          label="in force"
          value={expired ? "no" : notYet ? "not yet" : "yes"}
          sub={expired ? "reissue it" : `expires in ${expiry}`}
          tone={expired || notYet ? "no" : "ok"}
        />
        <Stat
          label="spent today"
          value={`${spent.toFixed(2)} USD`}
          sub={`of ${bundle.limits.dailyCapUsd}`}
          {...(spent >= cap ? { tone: "no" as const } : {})}
        />
        <Stat
          label="headroom"
          value={`${Math.max(cap - spent, 0).toFixed(2)} USD`}
          sub={`${bundle.limits.perTxCapUsd} USD per transaction`}
        />
        <Stat
          label="review above"
          value={`${bundle.limits.requireReviewAboveUsd} USD`}
          sub={`${bundle.limits.maxTxPerHour} actions per hour`}
        />
      </div>

      <h2>The five hashes</h2>
      <div className="panel">
        <table>
          <tbody>
            <tr>
              <th>remitHash</th>
              <td>
                <Hash value={bundle.remitHash} />{" "}
                <span className="muted">the EIP-712 digest</span>
              </td>
            </tr>
            <tr>
              <th>strategyHash</th>
              <td>
                <Hash value={bundle.remit.strategyHash} />{" "}
                <span className="muted">why the action happened</span>
              </td>
            </tr>
            <tr>
              <th>workflowHash</th>
              <td>
                <Hash value={bundle.remit.workflowHash} />{" "}
                <span className="muted">what exactly runs</span>
              </td>
            </tr>
            <tr>
              <th>limitsHash</th>
              <td>
                <Hash value={bundle.remit.limitsHash} />{" "}
                <span className="muted">how much, where, when</span>
              </td>
            </tr>
            <tr>
              <th>roleKey</th>
              <td>
                <Hash value={bundle.remit.roleKey} />{" "}
                <span className="muted">what is permitted at all</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>What it permits</h2>
      <div className="panel">
        <table>
          <tbody>
            <tr>
              <th>actions</th>
              <td className="mono">{bundle.limits.allowedIntentKinds.join(", ")}</td>
            </tr>
            <tr>
              <th>assets</th>
              <td className="mono">{bundle.limits.allowedAssets.join(", ")}</td>
            </tr>
            <tr>
              <th>functions</th>
              <td className="mono">{bundle.limits.allowedSelectors.join(", ")}</td>
            </tr>
            <tr>
              <th>contracts</th>
              <td className="mono">{bundle.limits.allowedTargets.join(", ")}</td>
            </tr>
            <tr>
              <th>value may land at</th>
              <td className="mono">
                {bundle.limits.allowedRecipients.join(", ")}
                <div className="muted" style={{ fontFamily: "inherit" }}>
                  The Safe, and nothing else. That one line is why exfiltration is not
                  expressible rather than merely disallowed.
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
