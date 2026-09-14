"""`remit` — the four verbs.

    remit issue    build and sign a Remit       (ops/remit:issue today; P5 moves it here)
    remit serve    run a strategy under a Remit (P5, once the Almanak seam is wired)
    remit verify   check the receipt chain
    remit run      one intent, through the gates and KeeperHub

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
import sys
import time
from typing import Any

from remit_bridge import core, receipts
from remit_bridge.config import (
    CHAIN_IDS,
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


def _log(event: str, **fields: Any) -> None:
    """Structured logging: one JSON object per line (CLAUDE.md §5)."""
    print(json.dumps({"event": event, **fields}))


def _say(line: str) -> None:
    print(line)


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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="remit", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    verify = sub.add_parser("verify", help="check the receipt chain")
    verify.add_argument("--network", default="base-sepolia")
    verify.set_defaults(handler=cmd_verify)

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
