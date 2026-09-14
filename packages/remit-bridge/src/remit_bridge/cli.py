"""`remit` — the four verbs.

    remit issue    build and sign a Remit
    remit serve    run a strategy under a Remit
    remit verify   check the receipt chain
    remit revoke   the kill switch

    remit run      one intent, through the gates and KeeperHub — the fifth verb, and the
                   honest name for what P3 has: a single hand-written intent, taken
                   through G1 and submitted by KeeperHub. `serve` is the same path with a
                   strategy on the front of it.

`run` is the honest name for what P3 has: a single hand-written intent, taken
through G1 and then submitted by KeeperHub. `serve` is the same path with an
Almanak strategy on the front of it, and it lands in P5.

Nothing here signs or broadcasts. Every transaction is submitted by KeeperHub
(PRD.md KH-1), so without an API key `run` stops — it does not fall back to a
local signer, because a fallback would make the project's central claim false in
exactly the case where it matters.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from remit_bridge import core, receipts
from remit_bridge.config import (
    CHAIN_IDS,
    REPO_ROOT,
    load_deployment,
    load_remit,
    receipts_dir,
    require_env,
)
from remit_bridge.errors import (
    ConfigError,
    EnvelopeRefused,
    KeeperHubError,
    ReceiptUnresolvable,
    RemitError,
)
from remit_bridge.keeperhub import KeeperHubClient
from remit_bridge.log import log_event

#: One implementation, in `log.py`, so a library module can use it too — a library that
#: `print`s is a library that cannot be embedded.
_log = log_event


def _say(line: str) -> None:
    print(line, flush=True)


def _build_intent(kind: str, amount_units: str, counterparty: str) -> dict[str, Any]:
    """Assemble a typed intent.

    Note what is absent: no calldata, no target, no ABI. The counterparty is the one
    address a caller may name, and G1 checks it against the Remit before anything
    else happens (CLAUDE.md §2.3).
    """
    base = {"kind": kind, "asset": "USDC", "amount": amount_units}
    if kind == "approve":
        return {**base, "spender": counterparty}
    if kind == "supply":
        return {**base, "onBehalfOf": counterparty}
    if kind == "withdraw":
        return {**base, "to": counterparty}
    raise ConfigError(f"--kind must be approve, supply or withdraw, not {kind}")


def _to_units(amount: str) -> str:
    """USDC has six decimals. Parsed exactly, never through a float."""
    whole, _, fraction = amount.partition(".")
    return str(int(whole or "0") * 1_000_000 + int((fraction or "").ljust(6, "0")[:6]))


def _ops(script: str, forwarded: list[str]) -> int:
    """Run one of the ops scripts and let its output through.

    `issue` and `revoke` are the two of the four verbs whose work is chain work: building
    and signing a document, and sending an owner transaction. That work lives in `ops`,
    where the keys and the deployment records are, and duplicating it here would be a
    second implementation of the thing the whole project is about not having.

    So they are wrappers, deliberately thin. The four verbs are the public surface
    (CLAUDE.md §1); where each one's work happens is an implementation detail, and an
    operator should not have to know two command vocabularies.
    """
    command = ["pnpm", "--filter", "ops", script, *forwarded]
    _log("ops.delegate", script=script, args=forwarded)
    completed = subprocess.run(command, cwd=REPO_ROOT, check=False)  # noqa: S603
    return completed.returncode


def cmd_issue(args: argparse.Namespace) -> int:
    """`remit issue` — build the Remit, then sign it as the owners this machine holds."""
    forwarded = [
        "--network",
        args.network,
        "--strategy",
        args.strategy,
        "--workflow",
        args.workflow,
    ]
    if args.days is not None:
        forwarded += ["--days", str(args.days)]

    code = _ops("remit:issue", forwarded)
    if code != 0:
        return code

    if args.sign:
        # Signing is a separate step because it can fail for a reason that is not a
        # failure: a 2-of-3 Safe whose second owner has not signed yet is a Remit waiting,
        # not a Remit broken.
        signed = _ops("remit:sign", ["--network", args.network])
        if signed != 0:
            _say("")
            _say("The Remit is issued but not signed to threshold yet. That is a")
            _say("normal intermediate state: another owner signs, and `remit serve`")
            _say("verifies it before accepting anything.")
    return 0


def cmd_revoke(args: argparse.Namespace) -> int:
    """`remit revoke` — the kill switch.

    One Safe owner transaction. It proves it took effect by re-running the preflight
    afterwards, and writes a receipt for the state either side of the transition.
    """
    forwarded = ["--network", args.network]
    if args.restore:
        forwarded.append("--restore")
    if args.confirm:
        forwarded.append("--confirm")
    return _ops("kill", forwarded)


def cmd_verify(args: argparse.Namespace) -> int:
    """Re-derive every hash on disk, and say so plainly."""
    directory = receipts_dir(args.network)
    try:
        bundle = load_remit(args.network)
        verification = core.verify_chain(
            directory, remit=bundle.remit, limits=bundle.limits
        )
        documents = "with the Remit and limits documents"
    except ConfigError:
        # A chain can be checked for internal consistency without the documents; it
        # just cannot be checked against them. Say which one happened.
        verification = core.verify_chain(directory)
        documents = "without the Remit documents (none found)"

    count = verification.get("count", 0)
    problems = verification.get("problems", [])

    _say(f"receipts   {directory}")
    _say(f"checked    {count} {documents}")
    _say(f"head       {verification.get('head')}")

    for problem in problems:
        _say(
            f"PROBLEM    #{problem.get('sequence')} {problem.get('file')}: "
            f"{problem.get('problem')} (expected {problem.get('expected')}, "
            f"got {problem.get('actual')})"
        )

    ok = bool(verification.get("ok"))
    _say("")
    _say(
        "chain intact — every hash re-derived from the bytes on disk"
        if ok
        else f"{len(problems)} problem(s): this chain does not prove what it claims"
    )
    _log("receipts.verified", network=args.network, ok=ok, count=count)
    return 0 if ok else 2


def cmd_run(args: argparse.Namespace) -> int:
    """One intent, through G1, then KeeperHub, then a receipt — whatever happened."""
    deployment = load_deployment(args.network)
    bundle = load_remit(args.network)
    directory = receipts_dir(args.network)

    counterparty = args.to or deployment.safe
    intent = _build_intent(args.kind, _to_units(args.amount), counterparty)
    _say(f"intent     {json.dumps(intent)}")

    # ---- G1: free, pure, and before any I/O ------------------------------
    try:
        decision = core.check_envelope(
            remit=bundle.remit,
            limits=bundle.limits,
            chain_id=CHAIN_IDS[args.network],
            intent=intent,
            now=int(time.time()),
            ledger=[],
        )
    except EnvelopeRefused as refusal:
        body = receipts.refused_at_g1(
            deployment=deployment,
            bundle=bundle,
            intent=intent,
            error=refusal.error,
        )
        written = receipts.write(directory, body)
        _say(f"G1 REFUSED {refusal.error.get('code')}: {refusal.error.get('message')}")
        _say(f"receipt    {written['file']}  {written['selfHash']}")
        _say("")
        _say("No network call was made. The refusal is recorded like any other outcome.")
        _log("gate.g1", outcome="refused", **refusal.error)
        return 2

    action = decision["action"]
    _say(f"G1 PASS    {action['description']}")
    _say(
        f"           {decision['usd']} USD, review required: {decision['requiresReview']}"
    )

    # ---- KeeperHub: the only thing that submits (KH-1) --------------------
    api_key = require_env(
        "KEEPERHUB_API_KEY",
        hint="every transaction is submitted by KeeperHub; there is no local-signer path",
    )
    workflow_id = os.environ.get("KEEPERHUB_WORKFLOW_ID", "")

    with KeeperHubClient(
        api_key,
        base_url=os.environ.get("KEEPERHUB_BASE_URL", "https://app.keeperhub.com"),
    ) as client:
        if workflow_id:
            accepted = client.execute_workflow(
                workflow_id,
                {
                    "safe": deployment.safe,
                    "rolesModifier": deployment.roles_modifier,
                    "roleKey": deployment.role_key,
                    "target": action["target"],
                    "value": "0",
                    "data": action["calldata"],
                    "operation": 0,
                },
            )
            kind = "workflow"
        else:
            # No registered workflow yet (OQ-1/OQ-7). The direct-execution route
            # submits the same call through the same service, and the receipt records
            # which route ran so the two are never confused.
            accepted = client.execute_contract_call(
                chain_id=deployment.chain_id,
                contract_address=deployment.roles_modifier,
                function_name="execTransactionWithRole",
                function_args=[
                    action["target"],
                    "0",
                    action["calldata"],
                    0,
                    deployment.role_key,
                    True,
                ],
            )
            kind = "direct"

        _say(f"submitted  executionId {accepted.execution_id} via the {kind} route")

        try:
            resolution = client.resolve_tx_hash(accepted.execution_id, kind=kind)
        except ReceiptUnresolvable as unresolved:
            body = receipts.build_body(
                deployment=deployment,
                bundle=bundle,
                intent=decision["intent"],
                action=action,
                usd=decision["usd"],
                gates=[
                    {"gate": "G1", "outcome": "pass"},
                    {
                        "gate": "G2",
                        "outcome": "skipped",
                        "detail": "run inside the workflow",
                    },
                    {"gate": "G4", "outcome": "reverted", "detail": unresolved.message},
                ],
                outcome="unresolved",
                submission=receipts.submission(
                    "keeperhub",
                    execution_id=unresolved.execution_id,
                    workflow_id=workflow_id or None,
                ),
            )
            written = receipts.write(directory, body)
            _say(f"UNRESOLVED {unresolved.message}")
            _say(f"receipt    {written['file']} — recorded without a hash, on purpose")
            _log("receipt.unresolvable", **unresolved.as_dict())
            return 3

    body = receipts.build_body(
        deployment=deployment,
        bundle=bundle,
        intent=decision["intent"],
        action=action,
        usd=decision["usd"],
        gates=[
            {"gate": "G1", "outcome": "pass"},
            {"gate": "G2", "outcome": "pass", "detail": "policy_check node"},
            {
                "gate": "G4",
                "outcome": "pass" if resolution.succeeded else "reverted",
                "detail": resolution.status,
            },
        ],
        outcome="executed" if resolution.succeeded else "reverted_g4",
        submission=receipts.submission(
            "keeperhub",
            execution_id=resolution.execution_id,
            workflow_id=workflow_id or None,
            tx_hash=resolution.tx_hash,
            explorer=resolution.explorer_link,
        ),
    )
    written = receipts.write(directory, body)

    _say(f"tx         {resolution.tx_hash}")
    _say(f"receipt    {written['file']}  {written['selfHash']}")
    _log(
        "receipt.written",
        executionId=resolution.execution_id,
        txHash=resolution.tx_hash,
        selfHash=written["selfHash"],
    )
    return 0 if resolution.succeeded else 4


def cmd_serve(args: argparse.Namespace) -> int:
    """Run the gateway an Almanak strategy talks to.

    Before it accepts a single intent it checks that the chain still says what the Remit
    claims it says (RM-4). A bridge that starts on drift is a bridge enforcing limits
    nobody is bound by: the Remit would promise the operator a recipient allowlist that
    the preset had stopped enforcing, and every gate downstream would agree with it.
    """
    from remit_bridge.adapters import almanak

    deployment = load_deployment(args.network)
    bundle = load_remit(args.network)
    rpc_url = almanak.env_rpc_url(args.network)

    check = core.check_preset(
        rpc_url=rpc_url,
        chain_id=deployment.chain_id,
        remit=bundle.remit,
        limits=bundle.limits,
        roles_modifier=deployment.roles_modifier,
        agent=deployment.agent_signer,
        from_block=deployment.roles_deployed_block,
        signatures=bundle.signatures,
    )

    _say(f"remit      {bundle.remit_hash}")
    _say(f"safe       {deployment.safe}")
    _say(f"roles      {deployment.roles_modifier}  role {deployment.role_key}")
    events = check.get("eventsReplayed")
    _say(f"chain read {events} event(s), as of block {check.get('asOfBlock')}")

    if not check.get("ok"):
        for finding in check.get("findings", []):
            _say(f"DRIFT      {finding.get('code')}: {finding.get('detail')}")
        _log("startup.refused", code="REMIT_PRESET_DRIFT", findings=check.get("findings"))
        _say("")
        _say(
            "refusing to start: the Remit and the chain disagree. Fix the preset with "
            "`roles:diff` and `roles:apply`, or reissue the Remit — do not widen either "
            "to make this pass."
        )
        return 5

    _say("preset     agrees with the Remit — the limits are enforced by the chain")
    _say(
        f"signed     {len(bundle.signatures)} owner signature(s), verified against the "
        "Safe's current owners"
        if bundle.signatures
        else "signed     no — the Remit is unsigned; the preset is still the authority"
    )

    # AL-1/AL-4: the Remit binds a *version* of the strategy. If the file on disk no
    # longer hashes to it, the receipts this run would write would name source that did
    # not produce them, and provenance is the one claim that cannot survive being
    # approximately true.
    strategy_path = Path(args.strategy).resolve()
    answer, _ = core.invoke("hash", {"file": str(strategy_path)})
    running = str(answer.get("fileHash", ""))
    bound = str(bundle.remit["strategyHash"])

    if running != bound:
        _say(f"strategy   {strategy_path}")
        _say(f"           hashes to {running}")
        _say(f"           the Remit binds {bound}")
        _log("startup.refused", code="REMIT_STRATEGY_DRIFT", running=running, bound=bound)
        _say("")
        _say(
            "refusing to start: this is not the strategy the Remit authorises. Reissue "
            "the Remit against this file, or check out the version it binds."
        )
        return 5

    _say(f"strategy   {strategy_path.name} matches the Remit's strategyHash")

    keeperhub = None
    api_key = os.environ.get("KEEPERHUB_API_KEY", "")
    if api_key:
        keeperhub = KeeperHubClient(
            api_key,
            base_url=os.environ.get("KEEPERHUB_BASE_URL", "https://app.keeperhub.com"),
        )
        _say("keeperhub  configured")
    else:
        # Started without credentials, the gateway still answers CompileIntent and a
        # dry-run Execute — G1 and G2 both run. It refuses a real Execute rather than
        # finding another way to send, which is the whole point of KH-1.
        _say("keeperhub  NOT configured — dry runs only, no transaction can be submitted")

    server = almanak.serve(
        deployment=deployment,
        bundle=bundle,
        rpc_url=rpc_url,
        keeperhub=keeperhub,
        workflow_id=os.environ.get("KEEPERHUB_WORKFLOW_ID") or None,
        host=args.host,
        port=args.port,
    )

    _say("")
    _say(f"listening  {args.host}:{args.port}")
    _say("point a strategy at it with:")
    _say(f"  ALMANAK_GATEWAY_HOST={args.host} ALMANAK_GATEWAY_PORT={args.port}")
    _log("serve.started", network=args.network, host=args.host, port=args.port)

    if args.once:
        # Used by the driver: start, hand control back, let the caller stop it.
        return 0

    try:
        server.wait_for_termination()
    except KeyboardInterrupt:
        server.stop(grace=1.0)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="remit", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    issue = sub.add_parser("issue", help="build and sign a Remit")
    issue.add_argument("--network", default="base-sepolia")
    issue.add_argument(
        "--strategy",
        default=str(REPO_ROOT / "strategies" / "remit_usdc_lender" / "strategy.py"),
    )
    issue.add_argument(
        "--workflow",
        default=str(REPO_ROOT / "ops" / "workflows" / "exec-with-role.workflow.json"),
    )
    issue.add_argument("--days", type=int, default=None)
    issue.add_argument(
        "--no-sign", dest="sign", action="store_false", help="issue without signing"
    )
    issue.set_defaults(handler=cmd_issue, sign=True)

    revoke = sub.add_parser("revoke", help="the kill switch")
    revoke.add_argument("--network", default="base-sepolia")
    revoke.add_argument("--restore", action="store_true", help="give the role back")
    revoke.add_argument("--confirm", action="store_true")
    revoke.set_defaults(handler=cmd_revoke)

    verify = sub.add_parser("verify", help="check the receipt chain")
    verify.add_argument("--network", default="base-sepolia")
    verify.set_defaults(handler=cmd_verify)

    serve = sub.add_parser("serve", help="run the gateway an Almanak strategy talks to")
    serve.add_argument("--network", default="base-sepolia")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=50_051)
    serve.add_argument(
        "--strategy",
        default=str(REPO_ROOT / "strategies" / "remit_usdc_lender" / "strategy.py"),
        help="the strategy file whose hash the Remit binds",
    )
    serve.add_argument("--once", action="store_true", help=argparse.SUPPRESS)
    serve.set_defaults(handler=cmd_serve)

    run = sub.add_parser("run", help="put one intent through the gates and KeeperHub")
    run.add_argument("--network", default="base-sepolia")
    run.add_argument("--kind", default="supply")
    run.add_argument("--amount", default="1")
    run.add_argument("--to", default=None, help="counterparty; defaults to the Safe")
    run.set_defaults(handler=cmd_run)

    args = parser.parse_args(argv)

    try:
        exit_code: int = args.handler(args)
    except RemitError as error:
        _log("fatal", **error.as_dict())
        _say(f"{error.code}: {error.message}")
        return 1
    except KeeperHubError as error:  # pragma: no cover - RemitError covers it
        _log("fatal", **error.as_dict())
        return 1
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
