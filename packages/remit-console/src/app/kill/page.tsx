import { rolesAbi } from "@remit/core";
import { encodeFunctionData } from "viem";
import { Figure, Hash, Problem } from "@/components/bits";
import { bundleState, explorerFor, readLiveState } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * The kill switch (CN-3).
 *
 * Two things an operator needs at 02:00: whether the agent can still act *right now*, and
 * the exact transaction to sign if it should not.
 *
 * The reading is live, from the chain, on every load. An unreachable chain is reported as
 * unreachable rather than as "no authority", because telling somebody the switch is pulled
 * when nobody checked is the worst answer this page could give.
 *
 * The console cannot pull the switch itself, and that is deliberate. Revoking is a Safe
 * owner transaction; it needs owner keys, which this process does not have and should not
 * want. What the page gives you is the calldata and the address to send it to, so the
 * switch works when our stack is the thing that has failed.
 */
export default async function KillSwitch() {
  const state = bundleState();

  if (state.kind === "unreadable") {
    return (
      <>
        <div className="head">
          <span className="eyebrow">the remit for {state.network}</span>
          <h1>Kill switch</h1>
        </div>
        <section>
          <Problem title={state.problem} detail={state.detail} />
          <p>
            The switch does not depend on this page, or on anything in this stack.{" "}
            <code>pnpm --filter ops kill --network {state.network}</code> revokes the role
            from a terminal, and a Safe owner can send the same transaction from anywhere.
          </p>
        </section>
      </>
    );
  }

  if (state.kind === "missing") {
    return (
      <div className="head">
        <span className="eyebrow">{state.network}</span>
        <h1>Kill switch</h1>
        <p className="lede">
          No Remit on this network, so no authority has been delegated and there is
          nothing to revoke.
        </p>
      </div>
    );
  }

  const { bundle } = state;
  const live = await readLiveState(bundle);
  const explorer = explorerFor(bundle.deployment.chainId);

  const verdict = !live.reachable ? "UNKNOWN" : live.isMember ? "ACTIVE" : "REVOKED";

  const revokeCalldata = encodeFunctionData({
    abi: rolesAbi,
    functionName: "assignRoles",
    args: [bundle.deployment.agentSigner, [bundle.remit.roleKey], [false]],
  });

  // Revoked inverts the screen. Nothing here is coloured, so the surface itself carries
  // the state — and a pulled switch is not something to discover by reading a label.
  return (
    <div {...(verdict === "REVOKED" ? { "data-inverted": "true" } : {})}>
      <div className="head">
        <span className="eyebrow">agent authority, read from the chain just now</span>
        <h1>{verdict}</h1>
        <p className="lede">{live.reason}</p>
      </div>

      <section>
        <div className="figures">
          <Figure
            label="agent"
            value={<Hash value={bundle.deployment.agentSigner} />}
            sub="the member being revoked"
          />
          <Figure
            label="role"
            value={<Hash value={bundle.remit.roleKey} />}
            sub="what it is a member of"
          />
          <Figure
            label="safe holds"
            value={`${live.safeUsdc} USDC`}
            sub={
              live.reachable
                ? "read from the chain on this page load"
                : "not read — the chain did not answer"
            }
            mark={live.reachable}
          />
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>The transaction to sign</h2>
          <span className="label">one owner transaction · instant · total</span>
        </div>

        <dl className="terms">
          <dt>from</dt>
          <dd>{bundle.remit.safe}</dd>
          <dd className="gloss">the Safe, signed by its owners at their threshold</dd>

          <dt>to</dt>
          <dd>
            <a
              href={`${explorer}/address/${bundle.deployment.rolesModifier}`}
              target="_blank"
              rel="noreferrer"
            >
              {bundle.deployment.rolesModifier}
            </a>
          </dd>
          <dd className="gloss">the Roles modifier</dd>

          <dt>value</dt>
          <dd>0</dd>
          <dd className="gloss">no native value, ever — the preset forbids it</dd>

          <dt>function</dt>
          <dd>
            assignRoles({bundle.deployment.agentSigner}, [{bundle.remit.roleKey}],
            [false])
          </dd>
          <dd className="gloss">
            revokes the agent&apos;s membership of that one role, and nothing else
          </dd>

          <dt>calldata</dt>
          <dd data-wide="true">{revokeCalldata}</dd>
        </dl>

        <p className="lede" style={{ marginTop: 28 }}>
          From a terminal: <code>pnpm --filter ops kill --network {bundle.network}</code>.
          It pulls the switch, proves it took effect by re-running the preflight, and
          writes a receipt for the state either side of the transition. Nothing in this
          stack is consulted to achieve any of that.
        </p>
      </section>
    </div>
  );
}
