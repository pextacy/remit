import { rolesAbi } from "@remit/core";
import { encodeFunctionData } from "viem";
import { Hash, Stat } from "@/components/bits";
import { explorerFor, loadBundle, readLiveState } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * The kill switch (CN-3).
 *
 * Two things an operator needs at 02:00: whether the agent can still act *right now*, and
 * the exact transaction to sign if it should not.
 *
 * The membership reading is live, from the chain, every time this page loads. It is taken
 * by simulating a call under the role, because Roles 2.1.0 exposes no getter for
 * membership — and an unreachable chain is reported as unreachable rather than as "no
 * authority", because telling someone the switch is pulled when nobody checked is the
 * worst answer this page could give.
 *
 * The console cannot pull the switch itself, and that is deliberate. Revoking is a Safe
 * owner transaction; it needs owner keys, which this process does not have and should not
 * want. What the page gives you is the calldata and the address to send it to, so the
 * switch works when our stack is the thing that has failed.
 */
export default async function KillSwitch() {
  const bundle = loadBundle();
  if (bundle === undefined) {
    return (
      <>
        <h1>Kill switch</h1>
        <p className="lede">No Remit for this network.</p>
      </>
    );
  }

  const live = await readLiveState(bundle);
  const explorer = explorerFor(bundle.deployment.chainId);

  const revokeCalldata = encodeFunctionData({
    abi: rolesAbi,
    functionName: "assignRoles",
    args: [bundle.deployment.agentSigner, [bundle.remit.roleKey], [false]],
  });

  return (
    <>
      <h1>Kill switch</h1>
      <p className="lede">
        One owner transaction. Instant, total, and it consults nothing in this stack —
        which is the property worth having.
      </p>

      <div className="grid">
        <Stat
          label="agent authority"
          value={!live.reachable ? "unknown" : live.isMember ? "active" : "revoked"}
          sub={live.reason}
          tone={!live.reachable ? "warn" : live.isMember ? "ok" : "no"}
        />
        <Stat
          label="safe holds"
          value={`${live.safeUsdc} USDC`}
          sub={bundle.remit.safe}
        />
        <Stat
          label="role"
          value={<Hash value={bundle.remit.roleKey} />}
          sub="the membership being revoked"
        />
      </div>

      <h2>The transaction to sign</h2>
      <div className="panel">
        <table>
          <tbody>
            <tr>
              <th>from</th>
              <td className="mono">
                the Safe {bundle.remit.safe}
                <div className="muted" style={{ fontFamily: "inherit" }}>
                  signed by its owners, at the Safe&apos;s threshold
                </div>
              </td>
            </tr>
            <tr>
              <th>to</th>
              <td className="mono">
                <a
                  href={`${explorer}/address/${bundle.deployment.rolesModifier}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {bundle.deployment.rolesModifier}
                </a>
              </td>
            </tr>
            <tr>
              <th>value</th>
              <td className="mono">0</td>
            </tr>
            <tr>
              <th>function</th>
              <td className="mono">
                assignRoles({bundle.deployment.agentSigner}, [{bundle.remit.roleKey}],
                [false])
              </td>
            </tr>
            <tr>
              <th>calldata</th>
              <td>
                <code style={{ wordBreak: "break-all" }}>{revokeCalldata}</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="muted">
        From a terminal: <code>pnpm --filter ops kill --network {bundle.network}</code>.
        It pulls the switch, then proves it took effect by re-running the preflight, and
        writes a receipt for the state either side of the transition.
      </p>
    </>
  );
}
