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

from remit_bridge import amounts, core, receipts, review
from remit_bridge.config import (
    REPO_ROOT,
    Deployment,
    env_rpc_url,
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
from remit_bridge.ledger import append_ledger, read_ledger
from remit_bridge.lock import file_lock
from remit_bridge.log import log_event
from remit_bridge.pipeline_lock import pipeline_lock_path

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


def _default_counterparty(kind: str, deployment: Deployment) -> str:
    """Where an intent points when the caller does not say.

    `approve` names a spender and the only thing worth approving is the venue the role
    may call anyway; everything else names where value lands, which is the Safe. G1
    checks the two against different lists for exactly this reason.
    """
    if kind == "approve":
        answer, _ = core.invoke(
            "compile",
            {
                "chainId": deployment.chain_id,
                # A one-unit supply, compiled only to be asked what it targets: the pool
                # address comes from the core's verified table rather than from a second
                # copy of it here.
                "intent": {
                    "kind": "supply",
                    "asset": "USDC",
                    "amount": "1",
                    "onBehalfOf": deployment.safe,
                },
            },
        )
        return str(answer["action"]["target"])
    return deployment.safe


def _to_units(amount: str) -> str:
    """USDC has six decimals. Parsed exactly, never through a float.

    One implementation, shared with the Almanak adapter. It was a second, looser copy:
    it truncated a seventh decimal where the adapter refuses one — so `--amount
    1.9999999` supplied 1.999999, a different action from the one that was typed — and
    it let `int("abc")` out as a traceback rather than a refusal.
    """
    try:
        return amounts.to_units(amount)
    except (TypeError, ValueError) as error:
        raise ConfigError(f"--amount {amount!r} is not an amount: {error}") from error


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
    # Receipts written under a Remit other than the one on disk. Not a fault: a Remit
    # expires and is reissued rather than widened, so any chain older than one Remit's
    # life spans several. Their hashes and links are checked like every other record;
    # what cannot be checked is the authority the supplied documents do not describe.
    unchecked = verification.get("uncheckedAgainstDocuments", [])

    _say(f"receipts   {directory}")
    _say(f"checked    {count} {documents}")
    _say(f"head       {verification.get('head')}")
    if unchecked:
        remits = sorted({str(record.get("remitHash")) for record in unchecked})
        _say(
            f"note       {len(unchecked)} receipt(s) name {len(remits)} earlier "
            "Remit(s); their hashes and links check out, their authority is not in "
            "these documents"
        )
        for remit_hash in remits:
            _say(f"           {remit_hash}")

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


def _checked_remit(network: str) -> Any:
    """Load the Remit, and re-derive the hash it claims for itself.

    Every receipt this process writes names `remitHash` as the authority the action
    happened under, and the file's own claim about that hash is the one field in it that
    nothing else checks. A document edited after it was issued would otherwise hand a
    whole chain of receipts a key that points at nothing — so it is recomputed from the
    document, by the same code that issued it, before anything is accepted.
    """
    bundle = load_remit(network)
    answer, _ = core.invoke("hash", {"remit": bundle.remit})
    derived = str(answer.get("remitHash", ""))

    if derived != bundle.remit_hash:
        raise ConfigError(
            f"ops/remits/{network}.json says its remitHash is {bundle.remit_hash}, but "
            f"the document hashes to {derived} — the file was edited after it was issued"
        )
    return bundle


def cmd_run(args: argparse.Namespace) -> int:
    """One intent, through G1, then KeeperHub, then a receipt — whatever happened.

    Held under the same lock the ops pipeline takes, for the same reason: G1's daily cap
    and rate limit are read-modify-write over a ledger that is only written once the
    chain has answered, and two runs evaluating them against the same state each see a
    day in which nothing has been spent. The wait allows for a KeeperHub execution to
    reach a terminal state ahead of us.
    """
    # Long enough for the holder to finish a review of its own and the chain work behind
    # it. `stale_seconds` is left at its default: the holder heartbeats while it works, so
    # a process killed mid-hold is displaced in a minute however long the hold was.
    with file_lock(
        pipeline_lock_path(args.network),
        timeout_seconds=float(args.review_timeout) + 120.0,
        on_wait=lambda holder: _say(
            f"WAITING    another proposal on {args.network} holds the gates: {holder}"
        ),
    ):
        return _run_locked(args)


def _run_locked(args: argparse.Namespace) -> int:
    deployment = load_deployment(args.network)
    bundle = _checked_remit(args.network)
    directory = receipts_dir(args.network)

    # RM-4, before anything is proposed. `serve` refuses to start on drift; `run` submits
    # through the same KeeperHub with the same authority and was checking nothing — so a
    # preset that had drifted made every limit in the Remit a promise the chain had
    # stopped keeping, and G1 would have agreed with it all the way to G4.
    check = core.check_preset(
        rpc_url=env_rpc_url(args.network),
        chain_id=deployment.chain_id,
        remit=bundle.remit,
        limits=bundle.limits,
        roles_modifier=deployment.roles_modifier,
        agent=deployment.agent_signer,
        from_block=deployment.roles_deployed_block,
        signatures=bundle.signatures,
    )
    if not check.get("ok"):
        for finding in check.get("findings", []):
            _say(f"DRIFT      {finding.get('code')}: {finding.get('detail')}")
        _log("run.refused", code="REMIT_PRESET_DRIFT", findings=check.get("findings"))
        _say("")
        _say(
            "refusing to run: the Remit and the chain disagree. Fix the preset with "
            "`roles:diff` and `roles:apply`, or reissue the Remit — do not widen either "
            "to make this pass."
        )
        return 5

    # The sensible default differs by kind, and getting it wrong is instructive: value
    # goes to the Safe, but an approval goes to the venue. `propose` has always picked
    # per kind; this defaulted every kind to the Safe, so `remit run --kind approve` was
    # refused at G1 as `OUT_OF_REMIT_SPENDER` unless the caller knew to pass `--to`.
    # G1 was right both times — the two paths simply disagreed about the default, which
    # is the one thing a product path and a hand-run path may not do.
    counterparty = args.to or _default_counterparty(args.kind, deployment)
    intent = _build_intent(args.kind, _to_units(args.amount), counterparty)
    _say(f"intent     {json.dumps(intent)}")

    # ---- G1: free, pure, and before any I/O ------------------------------
    try:
        decision = core.check_envelope(
            remit=bundle.remit,
            limits=bundle.limits,
            chain_id=deployment.chain_id,
            intent=intent,
            now=int(time.time()),
            # The real history, from the file the ops tooling shares. An empty list would
            # tell G1 that nothing has ever been spent, and the daily cap and the rate
            # limit — the two rules G1 can only enforce against a history — would pass
            # every time however much had already moved.
            ledger=read_ledger(args.network),
            # G3-5: the version this agent last executed under. When it differs from the
            # one the Remit binds, the strategy has changed since anybody watched it act
            # and the action is held for review whatever its size.
            seen_strategy_hash=core.seen_strategy_hash(directory),
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

    # ---- G2: one eth_call, no gas ----------------------------------------
    # Run, not assumed. The receipt below claims an outcome for this gate, and the claim
    # has to be a reading: the `policy_check` node that would run it inside a KeeperHub
    # workflow is the contribution in `packages/keeperhub-safe/`, which is not deployed
    # anywhere yet (README, "Transaction links"). Writing "G2 pass" without asking would
    # be the audit trail asserting a gate that never ran.
    check = core.preflight(
        rpc_url=env_rpc_url(args.network),
        chain_id=deployment.chain_id,
        roles_modifier=deployment.roles_modifier,
        role_key=deployment.role_key,
        agent=deployment.agent_signer,
        target=action["target"],
        calldata=action["calldata"],
    )

    if not check.get("ok"):
        reason = str(check.get("reason", "refused at G2"))
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
                    "outcome": "refused",
                    "code": str(check.get("code", "")),
                    "detail": reason,
                },
            ],
            outcome="rejected_g2",
            submission=receipts.submission("none"),
        )
        written = receipts.write(directory, body)
        _say(f"G2 REFUSED {check.get('code')}: {reason}")
        _say(f"receipt    {written['file']}  {written['selfHash']}")
        _say("")
        _say("One eth_call, no gas. Nothing was submitted.")
        _log("gate.g2", outcome="refused", reason=reason)
        return 3

    _say("G2 PASS    the Roles Modifier would allow this call")

    # ---- G3: a person, and silence is a refusal --------------------------
    #
    # This path recorded "G3 skipped" and submitted anyway, so an action over the Remit's
    # review threshold reached KeeperHub with nobody having looked at it. The queue and
    # the console it is read in already existed; only the wiring was missing.
    g3: list[dict[str, Any]] = []
    if decision.get("requiresReview"):
        review_id = review.new_id()
        reason = str(decision.get("reviewReason") or "above the Remit's review threshold")
        review.enqueue(
            review_id=review_id,
            network=args.network,
            remit_hash=bundle.remit_hash,
            intent=decision["intent"],
            action=action,
            usd=decision["usd"],
            # Exact, from the integer micro-dollars the gate computed.
            headroom_usd=amounts.micros_to_usd(decision.get("headroomMicros", "0")),
            reason=reason,
        )
        _say(f"G3 WAITING {review_id} — a person has to approve this in the console")
        _say(f"           {reason}")
        _log("gate.g3", outcome="waiting", id=review_id, usd=decision["usd"])

        answer = review.wait_for_decision(
            review_id, timeout_seconds=float(args.review_timeout)
        )
        approved = answer is not None and answer.get("decision") == "approved"
        by = "nobody" if answer is None else str(answer.get("by", "an operator"))

        if not approved:
            code = "G3_TIMEOUT" if answer is None else "G3_DECLINED"
            detail = (
                f"{review_id}: nobody answered in {args.review_timeout:.0f}s"
                if answer is None
                else f"{by}{f': {answer.get("note")}' if answer.get('note') else ''}"
            )
            body = receipts.build_body(
                deployment=deployment,
                bundle=bundle,
                intent=decision["intent"],
                action=action,
                usd=decision["usd"],
                gates=[
                    {"gate": "G1", "outcome": "pass"},
                    {"gate": "G2", "outcome": "pass"},
                    {
                        "gate": "G3",
                        "outcome": "declined",
                        "code": code,
                        "detail": detail,
                    },
                ],
                outcome="declined_g3",
                submission=receipts.submission("none"),
            )
            written = receipts.write(directory, body)
            _say(f"G3 {'TIMEOUT' if answer is None else 'DECLINED'} {detail}")
            _say(f"receipt    {written['file']}  {written['selfHash']}")
            _say("")
            _say("A person said no, or nobody said anything. Nothing was submitted.")
            _log("gate.g3", outcome="declined", id=review_id, code=code)
            return 4

        _say(f"G3 APPROVED {by}")
        _log("gate.g3", outcome="approved", id=review_id, by=by)
        g3 = [{"gate": "G3", "outcome": "pass", "detail": f"approved by {by}"}]

        # G1 again, at the time the action would actually happen. A review takes as long
        # as a person takes, and a Remit that expires while somebody is deciding is
        # authority the operator had already withdrawn.
        try:
            core.check_envelope(
                remit=bundle.remit,
                limits=bundle.limits,
                chain_id=deployment.chain_id,
                intent=decision["intent"],
                now=int(time.time()),
                ledger=read_ledger(args.network),
                seen_strategy_hash=core.seen_strategy_hash(directory),
            )
        except EnvelopeRefused as refusal:
            body = receipts.build_body(
                deployment=deployment,
                bundle=bundle,
                intent=decision["intent"],
                action=action,
                usd=decision["usd"],
                gates=[
                    {"gate": "G1", "outcome": "pass"},
                    {"gate": "G2", "outcome": "pass"},
                    *g3,
                    {
                        "gate": "G1",
                        "outcome": "refused",
                        "code": str(refusal.error.get("code", "OUT_OF_REMIT")),
                        "detail": f"{refusal.error.get('message')} — re-checked after "
                        "the review and no longer holds",
                    },
                ],
                outcome="rejected_g1",
                submission=receipts.submission("none"),
            )
            written = receipts.write(directory, body)
            _say(f"G1 REFUSED {refusal.error.get('code')} — after the review")
            _say(f"receipt    {written['file']}  {written['selfHash']}")
            return 2

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
            # No registered workflow: registering one is a console action nobody
            # has taken, so KEEPERHUB_WORKFLOW_ID is unset. The direct-execution route
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
                        "outcome": "pass",
                        "detail": "preflight clean, no gas spent",
                    },
                    *g3,
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
            {"gate": "G2", "outcome": "pass", "detail": "preflight clean, no gas spent"},
            *g3,
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
    # The receipt is sealed before the ledger is touched. A KeeperHub execution that
    # succeeded has already moved value, and the record of it is the thing that must
    # exist; `append_ledger` can legitimately raise — an unreadable ledger is a hard
    # failure by design — and doing it first meant an executed transaction could take the
    # process down before its receipt was written, leaving gas spent and no trace.
    written = receipts.write(directory, body)

    # Only once value actually moved: a reverted execution spent gas and moved nothing,
    # and charging it against the daily cap would tighten the remit every time the chain
    # said no.
    if resolution.succeeded:
        try:
            append_ledger(args.network, decision["entry"])
        except RemitError as error:
            # Loud, and not swallowed. The receipt is on disk; what is now in doubt is
            # the cap, and an operator has to know that before the next action.
            _say(
                "LEDGER     the spend could not be recorded — the daily cap is now wrong"
            )
            _log("ledger.append.failed", txHash=resolution.tx_hash, **error.as_dict())
            raise

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
    bundle = _checked_remit(args.network)
    rpc_url = env_rpc_url(args.network)

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
        review_timeout_seconds=float(args.review_timeout),
    )

    _say(
        f"review     actions above {bundle.limits.get('requireReviewAboveUsd', '?')} USD "
        f"wait for a person, up to {args.review_timeout}s; silence is a refusal"
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
    serve.add_argument(
        "--review-timeout",
        type=float,
        default=600.0,
        help="how long an action waits for a person before silence refuses it",
    )
    serve.add_argument("--once", action="store_true", help=argparse.SUPPRESS)
    serve.set_defaults(handler=cmd_serve)

    run = sub.add_parser("run", help="put one intent through the gates and KeeperHub")
    run.add_argument("--network", default="base-sepolia")
    run.add_argument("--kind", default="supply")
    run.add_argument("--amount", default="1")
    run.add_argument(
        "--to",
        default=None,
        help="counterparty; defaults to the Aave pool for approve, the Safe otherwise",
    )
    run.add_argument(
        "--review-timeout",
        type=float,
        default=600.0,
        help="how long an action above the threshold waits for a person",
    )
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
