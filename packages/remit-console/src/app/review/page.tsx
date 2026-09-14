import { readPending } from "@remit/core";
import { Empty, GatePill, Hash } from "@/components/bits";
import { REVIEW_ROOT } from "@/lib/paths";
import { submitDecision } from "./actions";

export const dynamic = "force-dynamic";

/**
 * The review queue (CN-1, G3-1, G3-2).
 *
 * What is shown is the decoded action in named parameters — the contract, the function,
 * the recipient, the money — and never raw calldata. An operator asked to approve a hex
 * blob is an operator being asked to rubber-stamp, and a gate that produces
 * rubber-stamping is worse than no gate, because it launders the decision.
 */
export default function Review() {
  const pending = readPending(REVIEW_ROOT);

  return (
    <>
      <h1>Review</h1>
      <p className="lede">
        Actions above the Remit&apos;s review threshold wait here. G1 and G2 have already
        passed; this is the gate that costs a person&apos;s attention.
      </p>

      {pending.length === 0 ? (
        <Empty>
          Nothing waiting. Run a proposal above the threshold with{" "}
          <code>pnpm --filter ops propose --review</code>.
        </Empty>
      ) : (
        pending.map((item) => (
          <div className="panel" key={item.id}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <strong>{item.action.description}</strong>
              <span className="pill warn">{item.action.usd} USD</span>
            </div>
            <p className="muted" style={{ margin: "8px 0 14px" }}>
              {item.reason}. Approving leaves {item.headroomUsd} USD of headroom today.
            </p>

            {item.balanceDelta === undefined ? null : (
              <p style={{ margin: "0 0 14px" }}>
                <span className="pill warn">safe USDC {item.balanceDelta.usdc}</span>{" "}
                <span className="muted">{item.balanceDelta.note}</span>
                <span
                  className="muted"
                  style={{ display: "block", fontSize: 12, marginTop: 4 }}
                >
                  Simulated against current state — the check on whether the call does
                  what its name says.
                </span>
              </p>
            )}

            <table>
              <tbody>
                <tr>
                  <th>contract</th>
                  <td className="mono">{item.action.target}</td>
                </tr>
                <tr>
                  <th>function</th>
                  <td className="mono">
                    {item.action.signature}{" "}
                    <span className="muted">{item.action.selector}</span>
                  </td>
                </tr>
                <tr>
                  <th>intent</th>
                  <td className="mono">{JSON.stringify(item.intent)}</td>
                </tr>
                <tr>
                  <th>remit</th>
                  <td>
                    <Hash value={item.remitHash} />
                  </td>
                </tr>
                <tr>
                  <th>gates</th>
                  <td className="gatelist">
                    {item.gates.map((gate) => (
                      <GatePill key={gate.gate} gate={gate.gate} outcome={gate.outcome} />
                    ))}
                  </td>
                </tr>
              </tbody>
            </table>

            <form className="actions" action={submitDecision}>
              <input type="hidden" name="id" value={item.id} />
              <input
                type="text"
                name="by"
                placeholder="who is deciding"
                defaultValue="operator"
              />
              <input type="text" name="note" placeholder="note (optional)" />
              <button className="approve" name="decision" value="approved" type="submit">
                Approve
              </button>
              <button className="decline" name="decision" value="declined" type="submit">
                Decline
              </button>
            </form>
          </div>
        ))
      )}
    </>
  );
}
