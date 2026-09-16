"""Almanak's execution seam, implemented.

A strategy running on Almanak does not know or care what is on the other end of its
gateway. It compiles an intent and asks for it to be executed:

    execution.CompileIntent(CompileIntentRequest(intent_type, intent_data, chain, wallet))
    execution.Execute(ExecuteRequest(action_bundle, dry_run, simulation_enabled, …))

Read from the SDK at the pinned version (`almanak==2.28.0`,
`almanak/framework/runner/_inner_runner_helpers.py` lines 180-290): `intent_data` is
``json.dumps(intent_params).encode()`` and `action_bundle` is whatever the *server*
returned from CompileIntent, handed straight back. The server owns that shape, and here
the server is Remit.

So this is the seam, served — `ExecutionServiceServicer` from Almanak's own generated
stubs, with no fork of the SDK and no patched strategy (PRD.md AL-2). A strategy is
pointed at Remit with `ALMANAK_GATEWAY_HOST` and `ALMANAK_GATEWAY_PORT`, and everything
it proposes arrives here.

**There is no strategy logic in this file** (AL-3). It maps one Almanak intent onto one
typed Remit intent and refuses anything it does not recognise. It decides nothing about
markets, sizing or timing — that is the strategy's job, and a bridge that second-guesses
it would be a second strategy nobody reviewed.
"""

from __future__ import annotations

import json
import os
import time
from concurrent import futures
from pathlib import Path
from typing import Any

import grpc
from almanak.gateway.proto import gateway_pb2, gateway_pb2_grpc

from remit_bridge import amounts, core, receipts, review
from remit_bridge.config import Deployment, RemitBundle, env_rpc_url, receipts_dir
from remit_bridge.errors import (
    ConfigError,
    EnvelopeRefused,
    ReceiptUnresolvable,
    RemitError,
)
from remit_bridge.keeperhub import KeeperHubClient
from remit_bridge.ledger import append_ledger, read_ledger
from remit_bridge.lock import LockTimeout, file_lock
from remit_bridge.log import log_event
from remit_bridge.pipeline_lock import pipeline_lock_path

#: Almanak intent types this adapter knows how to carry. Anything else is refused with a
#: code the strategy author can act on, rather than translated into something adjacent.
SUPPORTED_INTENTS = {"SUPPLY", "WITHDRAW"}

#: The only venue the Remit's preset scopes. A strategy naming another protocol is not a
#: strategy this Remit authorises, and silently routing it to Aave would be the bridge
#: making a decision that belongs to the operator.
SUPPORTED_PROTOCOLS = {"aave_v3", "aave-v3", "aavev3"}

SUPPORTED_TOKENS = {"USDC"}

#: Interfaces on which an unauthenticated gateway is only reachable from this machine.
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "[::1]"})

#: The SDK warns that symbol-based token references are deprecated and will be rejected
#: in Almanak 3.0, so a strategy may name the token by address instead. An address is
#: accepted only when it *equals the address this repository verified on chain* — the
#: comparison is against our own table, so a strategy still cannot name a token nobody
#: checked (CLAUDE.md §2.3).
VERIFIED_USDC = {
    8453: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    84_532: "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f",
}


def _resolve_token(reference: str, chain_id: int) -> str:
    """A symbol, or the verified address for this chain. Nothing else."""
    text = str(reference).strip()
    if text.upper() in SUPPORTED_TOKENS:
        return text.upper()
    if text.lower() == VERIFIED_USDC.get(chain_id):
        return "USDC"
    return text


#: USDC base units. The SDK sends human amounts as decimal strings ("5", "0.25").
#:
#: Re-exported rather than reimplemented: `remit run` had a second, looser copy of this
#: conversion that truncated a seventh decimal instead of refusing it, so one amount
#: meant two different actions depending on which door it came through.
USDC_DECIMALS = amounts.USDC_DECIMALS
_units = amounts.to_units


class AdapterRefusalError(RemitError):
    """The adapter will not carry this intent. Carries the code the seam reports."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def map_intent(
    intent_type: str, params: dict[str, Any], safe: str, chain_id: int
) -> dict[str, Any]:
    """One Almanak intent → one Remit intent.

    The whole mapping, and deliberately nothing else. Note what it refuses: an unknown
    intent type, an unknown protocol, an unknown token, a chained ``"all"`` amount. The
    last one matters — ``amount="all"`` means "whatever the previous step produced", which
    is a number this adapter does not know and must not guess.

    The recipient is always the Safe. Almanak's supply and withdraw intents do not name
    one; the preset pins it on chain anyway, and naming it here keeps G1 checking the same
    field the chain checks.
    """
    kind = intent_type.upper()
    if kind not in SUPPORTED_INTENTS:
        raise AdapterRefusalError(
            "INTENT_KIND_UNSUPPORTED",
            f"this Remit carries {'/'.join(sorted(SUPPORTED_INTENTS))}, not {kind}",
        )

    protocol = str(params.get("protocol", "")).lower()
    if protocol not in SUPPORTED_PROTOCOLS:
        raise AdapterRefusalError(
            "PROTOCOL_UNSUPPORTED",
            f"the preset scopes Aave v3 only; the strategy asked for '{protocol}'",
        )

    token = _resolve_token(params.get("token", ""), chain_id)
    if token not in SUPPORTED_TOKENS:
        allowed = "/".join(sorted(SUPPORTED_TOKENS))
        raise AdapterRefusalError(
            "ASSET_UNSUPPORTED",
            f"the Remit allows {allowed}, the strategy asked for '{token}'",
        )

    amount = params.get("amount")
    if amount == "all":
        raise AdapterRefusalError(
            "AMOUNT_CHAINED",
            "amount='all' takes its value from a previous step; this adapter carries one "
            "action at a time and will not guess what that was",
        )

    try:
        units = _units(str(amount))
    except (TypeError, ValueError) as error:
        raise AdapterRefusalError(
            "AMOUNT_INVALID", f"amount {amount!r} is not an amount: {error}"
        ) from error

    if kind == "SUPPLY":
        return {"kind": "supply", "asset": "USDC", "amount": units, "onBehalfOf": safe}
    return {"kind": "withdraw", "asset": "USDC", "amount": units, "to": safe}


class RemitExecutionService(gateway_pb2_grpc.ExecutionServiceServicer):
    """Almanak's ExecutionService, answered by the four gates."""

    def __init__(
        self,
        *,
        deployment: Deployment,
        bundle: RemitBundle,
        rpc_url: str,
        keeperhub: KeeperHubClient | None,
        workflow_id: str | None = None,
        review_dir: Path | None = None,
        review_timeout_seconds: float = review.DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._deployment = deployment
        self._bundle = bundle
        self._rpc_url = rpc_url
        self._keeperhub = keeperhub
        self._workflow_id = workflow_id
        self._receipts = receipts_dir(deployment.network)
        self._review_dir = review_dir if review_dir is not None else review.REVIEW_ROOT
        self._review_timeout = review_timeout_seconds

    # ---- phase 1: compile -------------------------------------------------

    def CompileIntent(  # noqa: N802 - the name is Almanak's
        self, request: Any, context: Any
    ) -> Any:
        """Map the intent, then run G1 — before any I/O, as the gate requires."""
        del context

        try:
            params = json.loads(request.intent_data or b"{}")
        except json.JSONDecodeError:
            return gateway_pb2.CompilationResult(
                success=False,
                error="intent_data was not JSON",
                error_code="INTENT_MALFORMED",
            )

        try:
            intent = map_intent(
                request.intent_type,
                params,
                self._deployment.safe,
                self._deployment.chain_id,
            )
        except AdapterRefusalError as refusal:
            self._record_refusal(params, refusal.code, refusal.message)
            return gateway_pb2.CompilationResult(
                success=False, error=refusal.message, error_code=refusal.code
            )

        try:
            decision = core.check_envelope(
                remit=self._bundle.remit,
                limits=self._bundle.limits,
                chain_id=self._deployment.chain_id,
                intent=intent,
                now=int(time.time()),
                # What the agent has already spent, from the file the ops tooling writes
                # too. An empty list here would hand G1 a history in which nothing ever
                # happened, and `dailyCapUsd` and `maxTxPerHour` — both of which G1 can
                # only enforce against a history — would be decoration.
                ledger=read_ledger(self._deployment.network),
                # G3-5: the version this agent last executed under. When it differs from
                # the one the Remit binds, the strategy has changed since anybody watched
                # it act and the next action is held for review whatever its size.
                seen_strategy_hash=core.seen_strategy_hash(self._receipts),
            )
        except EnvelopeRefused as refusal:
            body = receipts.refused_at_g1(
                deployment=self._deployment,
                bundle=self._bundle,
                intent=intent,
                error=refusal.error,
            )
            receipts.write(self._receipts, body)
            return gateway_pb2.CompilationResult(
                success=False,
                error=str(refusal.error.get("message", "refused at G1")),
                error_code=str(refusal.error.get("code", "OUT_OF_REMIT")),
            )

        # The bundle is ours to define: Almanak hands it straight back to Execute. It
        # carries the decision, not calldata to be trusted — Execute re-checks it.
        bundle = {
            "remitHash": self._bundle.remit_hash,
            "intent": decision["intent"],
            "action": decision["action"],
            "usd": decision["usd"],
            "requiresReview": decision["requiresReview"],
        }
        return gateway_pb2.CompilationResult(
            success=True, action_bundle=json.dumps(bundle).encode()
        )

    # ---- phase 2: execute -------------------------------------------------

    def Execute(self, request: Any, context: Any) -> Any:  # noqa: N802 - Almanak's name
        """G1 again, then G2, then KeeperHub. A receipt either way.

        Serialised per network, against the *same* lock file the ops pipeline takes. The
        gateway answers on a thread pool and a strategy runner may have several actions
        in flight, so without this two Executes each read a day in which the other has
        spent nothing — and `dailyCapUsd` becomes a per-request cap. Refusing to wait is
        the safe answer: a cap counted against a history somebody else is still changing
        is not a cap.
        """
        del context

        try:
            # Long enough for the holder to finish a review of its own and the chain work
            # behind it. A fixed 300s was shorter than this server's own 600s review
            # window, so a second Execute refused while the first was legitimately still
            # waiting for a person — a refusal, not a race, but one the operator would
            # read as a bug rather than as a queue.
            #
            # `stale_seconds` is left at its default: the holder heartbeats while it
            # works, so the window is "how long since it last said it was alive" rather
            # than "how long it has held".
            with file_lock(
                pipeline_lock_path(self._deployment.network),
                timeout_seconds=self._review_timeout + 120.0,
                on_wait=lambda holder: log_event(
                    "pipeline.waiting",
                    network=self._deployment.network,
                    holder=holder,
                ),
            ):
                return self._execute_locked(request)
        except LockTimeout as busy:
            return gateway_pb2.ExecutionResult(
                success=False, error=busy.message, error_code=busy.code
            )

    def _execute_locked(self, request: Any) -> Any:
        try:
            bundle = json.loads(request.action_bundle or b"{}")
        except json.JSONDecodeError:
            return gateway_pb2.ExecutionResult(
                success=False,
                error="action_bundle was not JSON",
                error_code="BUNDLE_MALFORMED",
            )

        if bundle.get("remitHash") != self._bundle.remit_hash:
            # The bundle came back over a wire. A bundle for another Remit is either a
            # stale client or something worse, and neither is a thing to execute.
            return gateway_pb2.ExecutionResult(
                success=False,
                error="action_bundle was compiled under a different Remit",
                error_code="REMIT_MISMATCH",
            )

        intent = bundle.get("intent", {})

        # G1 again. The gate is pure and cheap, and the alternative is trusting a
        # round-tripped decision — which is exactly the shape of every deserialisation bug
        # that ever became a security bug.
        try:
            decision = core.check_envelope(
                remit=self._bundle.remit,
                limits=self._bundle.limits,
                chain_id=self._deployment.chain_id,
                intent=intent,
                now=int(time.time()),
                ledger=read_ledger(self._deployment.network),
                seen_strategy_hash=core.seen_strategy_hash(self._receipts),
            )
        except EnvelopeRefused as refusal:
            body = receipts.refused_at_g1(
                deployment=self._deployment,
                bundle=self._bundle,
                intent=intent,
                error=refusal.error,
            )
            receipts.write(self._receipts, body)
            return gateway_pb2.ExecutionResult(
                success=False,
                error=str(refusal.error.get("message")),
                error_code=str(refusal.error.get("code")),
            )

        action = decision["action"]

        # ---- G2 -----------------------------------------------------------
        check = core.preflight(
            rpc_url=self._rpc_url,
            chain_id=self._deployment.chain_id,
            roles_modifier=self._deployment.roles_modifier,
            role_key=self._deployment.role_key,
            agent=self._deployment.agent_signer,
            target=action["target"],
            calldata=action["calldata"],
        )

        if not check.get("ok"):
            reason = str(check.get("reason", "refused at G2"))
            self._write(
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
            return gateway_pb2.ExecutionResult(
                success=False,
                error=reason,
                error_code=str(check.get("code", "G2_REFUSED")),
            )

        # ---- G3: a person, and silence is a refusal -----------------------
        #
        # This used to record `{"gate": "G3", "outcome": "skipped"}` and submit anyway, so
        # the gate whose cost is a person's attention did not exist on the path that
        # actually runs a strategy. It is the same queue the ops pipeline writes and the
        # console reads — G3 was built, it was simply not wired to the product path.
        #
        # After G2, so a reviewer is never asked about a call the chain would refuse; and
        # before the dry run returns, because a dry run submits nothing and there is
        # nobody to ask about it.
        g3: list[dict[str, Any]] = []
        if decision.get("requiresReview") and not request.dry_run:
            approved, held = self._hold_for_review(decision, action)
            if held is not None:
                return held
            g3 = approved

        # ---- dry run stops here -------------------------------------------
        if request.dry_run:
            g3 = (
                [
                    {
                        "gate": "G3",
                        "outcome": "skipped",
                        "detail": str(
                            decision.get("reviewReason")
                            or "over the Remit's review threshold"
                        )
                        + " — a dry run submits nothing, so nobody was asked",
                    }
                ]
                if decision.get("requiresReview")
                else []
            )
            self._write(
                intent=decision["intent"],
                action=action,
                usd=decision["usd"],
                gates=[
                    {"gate": "G1", "outcome": "pass"},
                    {"gate": "G2", "outcome": "pass", "detail": "no gas spent"},
                    *g3,
                    {"gate": "G4", "outcome": "skipped", "detail": "dry run"},
                ],
                outcome="observed",
                submission=receipts.submission("none"),
            )
            return gateway_pb2.ExecutionResult(
                success=True, execution_plan_hash=self._bundle.remit_hash
            )

        # ---- G4, through KeeperHub and nothing else -----------------------
        if self._keeperhub is None:
            return gateway_pb2.ExecutionResult(
                success=False,
                error=(
                    "no KeeperHub credentials: every transaction is submitted by "
                    "KeeperHub and there is no local-signer path"
                ),
                error_code="CONFIG_MISSING",
            )

        try:
            accepted = self._submit(action)
            resolution = self._keeperhub.resolve_tx_hash(
                accepted.execution_id, kind="workflow" if self._workflow_id else "direct"
            )
        except ReceiptUnresolvable as unresolved:
            self._write(
                intent=decision["intent"],
                action=action,
                usd=decision["usd"],
                gates=[
                    {"gate": "G1", "outcome": "pass"},
                    {"gate": "G2", "outcome": "pass"},
                    *g3,
                    {"gate": "G4", "outcome": "reverted", "detail": unresolved.message},
                ],
                outcome="unresolved",
                submission=receipts.submission(
                    "keeperhub", execution_id=unresolved.execution_id
                ),
            )
            return gateway_pb2.ExecutionResult(
                success=False, error=unresolved.message, error_code="RECEIPT_UNRESOLVABLE"
            )
        except RemitError as error:
            return gateway_pb2.ExecutionResult(
                success=False, error=error.message, error_code=error.code
            )

        # The receipt is sealed before the ledger is touched: a KeeperHub execution that
        # succeeded has already moved value, and the record of it is the thing that must
        # exist. `append_ledger` can legitimately raise — an unreadable ledger is a hard
        # failure by design — and doing it first left an executed transaction with gas
        # spent and no trace.
        self._write(
            intent=decision["intent"],
            action=action,
            usd=decision["usd"],
            gates=[
                {"gate": "G1", "outcome": "pass"},
                {"gate": "G2", "outcome": "pass"},
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
                workflow_id=self._workflow_id,
                tx_hash=resolution.tx_hash,
                explorer=resolution.explorer_link,
            ),
        )

        # The cap is consumed only once value actually moved. A reverted execution spent
        # gas and moved nothing, and charging it against the daily allowance would tighten
        # the remit every time the chain said no.
        if resolution.succeeded:
            try:
                append_ledger(self._deployment.network, decision["entry"])
            except RemitError as error:
                # Reported, never swallowed. The receipt is on disk; what is in doubt is
                # the cap, and the strategy has to hear that rather than a success.
                log_event(
                    "ledger.append.failed",
                    txHash=resolution.tx_hash,
                    **error.as_dict(),
                )
                return gateway_pb2.ExecutionResult(
                    success=False,
                    error=(
                        "the transaction landed and the spend could not be recorded — "
                        f"the daily cap is now wrong: {error.message}"
                    ),
                    error_code="LEDGER_UNWRITABLE",
                    tx_hashes=[resolution.tx_hash],
                    execution_id=resolution.execution_id,
                )

        # KH-5's evidence is KeeperHub's run log, and the executionId is how it is
        # addressed. Logged rather than copied into the receipt: a receipt should carry
        # the key to the evidence, not a snapshot of it that can drift.
        if self._keeperhub is not None:
            log = self._keeperhub.run_log(
                resolution.execution_id,
                kind="workflow" if self._workflow_id else "direct",
            )
            log_event(
                "keeperhub.run_log",
                executionId=log.execution_id,
                status=log.status_url,
                cli=log.cli_command,
            )

        return gateway_pb2.ExecutionResult(
            success=resolution.succeeded,
            tx_hashes=[resolution.tx_hash],
            execution_id=resolution.execution_id,
            execution_plan_hash=self._bundle.remit_hash,
            submission_transactions=[
                gateway_pb2.SubmissionTransactionEvidence(
                    tx_id=resolution.tx_hash,
                    role=gateway_pb2.EXECUTION_TRANSACTION_ROLE_ACTION,
                    # AL-5, stated in Almanak's own vocabulary: never replay this.
                    #
                    # KeeperHub owns nonce management, gas escalation and retries for this
                    # submission. A replay from Almanak's side would be a *second*
                    # submission of the same intent racing KeeperHub's own resubmission —
                    # a double-spend risk dressed as a recovery. The two systems must not
                    # both be deciding when to resend.
                    replay_policy=gateway_pb2.REPLAY_POLICY_NEVER,
                )
            ],
        )

    # ---- coexisting with Almanak's own reliability machinery ---------------
    #
    # AL-5. Almanak ships a stuck detector
    # (`almanak/framework/services/stuck_detector.py`) that watches
    # `snapshot.pending_transactions` — each carrying a `tx_hash`, a **nonce**, a **gas
    # price** and a `submitted_at` — and flags `GAS_PRICE_BLOCKED` when a pending
    # transaction's gas price falls below a ratio of current, or `NONCE_CONFLICT` on a
    # duplicate or a gap in the nonce sequence.
    #
    # Every one of those signals is about a transaction the *strategy's own wallet* sent.
    # A KeeperHub submission has none of those properties from the strategy's side: the
    # wallet's nonce never advances, the gas price is KeeperHub's and is escalated by
    # KeeperHub, and a resubmission changes the hash. Presenting one as a pending
    # transaction would hand the detector three facts that are all true of something else,
    # and its remediation — replace the transaction — would race the resubmission
    # KeeperHub is already doing.
    #
    # Two properties keep them out of each other's way, and both are deliberate:
    #
    # 1. `Execute` does not return until the execution is **terminal**. `resolve_tx_hash`
    #    polls to `completed`/`failed`, so from the strategy's point of view there is
    #    never a KeeperHub-managed transaction in flight to detect as stuck. The cost is
    #    a blocking call; the alternative is two systems recovering the same transaction.
    #
    # 2. Every submission is reported with `REPLAY_POLICY_NEVER`, which is Almanak's own
    #    word for the same thing.
    #
    # What Almanak's alerting *keeps* is everything that is genuinely its business: the
    # strategy's balances, its allowances, its position state, and a failed execution —
    # `success=False` with an `error_code` — which reaches its normal failure handling
    # unchanged.

    # ---- phase 3: status --------------------------------------------------

    def GetTransactionStatus(  # noqa: N802 - Almanak's name
        self, request: Any, context: Any
    ) -> Any:
        """What the chain says about a hash. A read, with no rules in it."""
        del context
        status = core.tx_status(rpc_url=self._rpc_url, tx_hash=request.tx_hash)
        return gateway_pb2.TxStatus(
            status=str(status.get("status", "pending")),
            confirmations=int(status.get("confirmations", 0)),
            block_number=int(status.get("blockNumber", 0)),
            gas_used=int(status.get("gasUsed", 0)),
        )

    # ---- plumbing ---------------------------------------------------------

    def _submit(self, action: dict[str, Any]) -> Any:
        if self._keeperhub is None:  # pragma: no cover - guarded by the caller
            raise ConfigError("KEEPERHUB_API_KEY is not set")

        if self._workflow_id:
            return self._keeperhub.execute_workflow(
                self._workflow_id,
                {
                    "safe": self._deployment.safe,
                    "rolesModifier": self._deployment.roles_modifier,
                    "roleKey": self._deployment.role_key,
                    "target": action["target"],
                    "value": "0",
                    "data": action["calldata"],
                    "operation": 0,
                },
            )

        return self._keeperhub.execute_contract_call(
            chain_id=self._deployment.chain_id,
            contract_address=self._deployment.roles_modifier,
            function_name="execTransactionWithRole",
            function_args=[
                action["target"],
                "0",
                action["calldata"],
                0,
                self._deployment.role_key,
                True,
            ],
        )

    def _hold_for_review(
        self, decision: dict[str, Any], action: dict[str, Any]
    ) -> tuple[list[dict[str, Any]], Any | None]:
        """Put the action in front of a person.

        Returns ``(gates, None)`` when somebody approved — the G3 entry to put in the
        receipt — and ``([], result)`` otherwise, where `result` is the terminal
        `ExecutionResult` to hand back: a decline, a timeout, or a queue that could not be
        written. Every one of those is a refusal with a receipt, because a review that
        resolves into an approval by default is not a review, and an action nobody could
        be asked about is not an action that was reviewed.

        The answer is returned rather than stashed on the servicer: gRPC serves this on a
        thread pool, and instance state shared between requests is a race the next reader
        has to notice. The pipeline lock happens to serialise Execute today; a value that
        only works because of a lock somewhere else is not a value to leave lying about.
        """
        review_id = review.new_id()
        reason = str(decision.get("reviewReason") or "above the Remit's review threshold")
        # Exact, from the integer micro-dollars the gate computed. Float division put
        # a number on the reviewer's screen that was not the headroom.
        headroom = amounts.micros_to_usd(decision.get("headroomMicros", "0"))

        try:
            review.enqueue(
                review_id=review_id,
                network=self._deployment.network,
                remit_hash=self._bundle.remit_hash,
                intent=decision["intent"],
                action=action,
                usd=decision["usd"],
                headroom_usd=headroom,
                reason=reason,
                directory=self._review_dir,
            )
        except RemitError as error:
            self._write(
                intent=decision["intent"],
                action=action,
                usd=decision["usd"],
                gates=[
                    {"gate": "G1", "outcome": "pass"},
                    {"gate": "G2", "outcome": "pass"},
                    {
                        "gate": "G3",
                        "outcome": "declined",
                        "code": "G3_QUEUE_UNAVAILABLE",
                        "detail": f"{reason} — {error.message}",
                    },
                ],
                outcome="declined_g3",
                submission=receipts.submission("none"),
            )
            return [], gateway_pb2.ExecutionResult(
                success=False, error=error.message, error_code=error.code
            )

        log_event(
            "gate.g3",
            outcome="waiting",
            id=review_id,
            usd=decision["usd"],
            reason=reason,
        )
        answer = review.wait_for_decision(
            review_id,
            timeout_seconds=self._review_timeout,
            directory=self._review_dir,
        )

        if answer is None:
            self._write(
                intent=decision["intent"],
                action=action,
                usd=decision["usd"],
                gates=[
                    {"gate": "G1", "outcome": "pass"},
                    {"gate": "G2", "outcome": "pass"},
                    {
                        "gate": "G3",
                        "outcome": "declined",
                        "code": "G3_TIMEOUT",
                        "detail": f"{review_id}: nobody answered in "
                        f"{self._review_timeout:.0f}s",
                    },
                ],
                outcome="declined_g3",
                submission=receipts.submission("none"),
            )
            log_event("gate.g3", outcome="timeout", id=review_id)
            return [], gateway_pb2.ExecutionResult(
                success=False,
                error="nobody answered the review; silence is a refusal",
                error_code="G3_TIMEOUT",
            )

        by = str(answer.get("by", "an operator"))
        note = str(answer.get("note", ""))
        detail = f"{by}{f': {note}' if note else ''}"

        if answer.get("decision") != "approved":
            self._write(
                intent=decision["intent"],
                action=action,
                usd=decision["usd"],
                gates=[
                    {"gate": "G1", "outcome": "pass"},
                    {"gate": "G2", "outcome": "pass"},
                    {
                        "gate": "G3",
                        "outcome": "declined",
                        "code": "G3_DECLINED",
                        "detail": detail,
                    },
                ],
                outcome="declined_g3",
                submission=receipts.submission("none"),
            )
            log_event("gate.g3", outcome="declined", id=review_id, by=by)
            return [], gateway_pb2.ExecutionResult(
                success=False, error=f"declined by {detail}", error_code="G3_DECLINED"
            )

        log_event("gate.g3", outcome="approved", id=review_id, by=by)
        approved = {"gate": "G3", "outcome": "pass", "detail": f"approved by {detail}"}

        # G1 again, at the time the action would actually happen.
        #
        # A review takes as long as a person takes, and the first pass answered about
        # `now` as it was before anybody looked. A Remit that expires during the review
        # would otherwise be authority the operator had already withdrawn, spent because
        # somebody clicked approve just after it lapsed. Pure, so it costs nothing, and
        # it can only narrow.
        try:
            core.check_envelope(
                remit=self._bundle.remit,
                limits=self._bundle.limits,
                chain_id=self._deployment.chain_id,
                intent=decision["intent"],
                now=int(time.time()),
                ledger=read_ledger(self._deployment.network),
                seen_strategy_hash=core.seen_strategy_hash(self._receipts),
            )
        except EnvelopeRefused as refusal:
            self._write(
                intent=decision["intent"],
                action=action,
                usd=decision["usd"],
                gates=[
                    {"gate": "G1", "outcome": "pass"},
                    {"gate": "G2", "outcome": "pass"},
                    approved,
                    {
                        "gate": "G1",
                        "outcome": "refused",
                        "code": str(refusal.error.get("code", "OUT_OF_REMIT")),
                        "detail": f"{refusal.error.get('message')} — the envelope was "
                        "re-checked after the review and no longer holds",
                    },
                ],
                outcome="rejected_g1",
                submission=receipts.submission("none"),
            )
            return [], gateway_pb2.ExecutionResult(
                success=False,
                error=str(refusal.error.get("message")),
                error_code=str(refusal.error.get("code")),
            )

        return [approved], None

    def _write(self, **kwargs: Any) -> None:
        body = receipts.build_body(
            deployment=self._deployment, bundle=self._bundle, **kwargs
        )
        receipts.write(self._receipts, body)

    def _record_refusal(self, params: dict[str, Any], code: str, message: str) -> None:
        """A refusal before the intent was even mappable still leaves a record.

        What the strategy sent is stored verbatim, under the receipt's `unparseable`
        kind. It has to be that rather than a typed intent: nothing here mapped, so there
        is no intent to record, and writing a plausible one — a zero-value supply, say —
        would put an action in the audit trail that no strategy ever proposed and no
        reviewer could distinguish from one that was.
        """
        body = receipts.refused_at_g1(
            deployment=self._deployment,
            bundle=self._bundle,
            intent=receipts.unparseable(params),
            error={"code": code, "message": message},
        )
        receipts.write(self._receipts, body)


def serve(
    *,
    deployment: Deployment,
    bundle: RemitBundle,
    rpc_url: str,
    keeperhub: KeeperHubClient | None,
    workflow_id: str | None,
    host: str = "127.0.0.1",
    port: int = 50051,
    review_timeout_seconds: float = review.DEFAULT_TIMEOUT_SECONDS,
) -> grpc.Server:
    """Start the gateway a strategy talks to.

    The strategy is pointed here with `ALMANAK_GATEWAY_HOST` and `ALMANAK_GATEWAY_PORT`
    — the precedence ladder is Almanak's own (`GatewayClientConfig.from_env`), so nothing
    about the strategy changes.
    """
    # `add_insecure_port` is what Almanak's own gateway uses and what its client expects,
    # and there is no authentication in front of it. On loopback that is the same trust
    # boundary as the filesystem the receipts live on. On any other interface it is an
    # unauthenticated endpoint that submits transactions from the Safe's role, reachable
    # by anyone who can route to the port — so binding there has to be something an
    # operator says out loud, in an environment variable, rather than something they get
    # by typing `--host 0.0.0.0` to make a container work.
    if host not in LOOPBACK_HOSTS and os.environ.get("REMIT_ALLOW_REMOTE_GATEWAY") != "1":
        raise ConfigError(
            f"refusing to serve the gateway on {host}: the port is unauthenticated and "
            "anything that reaches it can propose actions under the Remit. Bind it to "
            "127.0.0.1 and reach it through a tunnel, or set "
            "REMIT_ALLOW_REMOTE_GATEWAY=1 to say you have put authentication in front "
            "of it yourself."
        )

    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    gateway_pb2_grpc.add_ExecutionServiceServicer_to_server(
        RemitExecutionService(
            deployment=deployment,
            bundle=bundle,
            rpc_url=rpc_url,
            keeperhub=keeperhub,
            workflow_id=workflow_id,
            review_timeout_seconds=review_timeout_seconds,
        ),
        server,
    )
    if server.add_insecure_port(f"{host}:{port}") == 0:
        # gRPC reports a port it could not bind by returning 0 and starting anyway, so a
        # server that never listened would otherwise print "listening" and wait forever.
        raise ConfigError(f"could not bind {host}:{port} — is something already on it?")
    server.start()
    return server


#: Re-exported: `drive.py` reaches for it as `adapter.env_rpc_url`, and it lives in
#: `config` so that a verb with no strategy on the front of it need not import a
#: gateway runtime to find out which node to ask.
__all__ = ["RemitExecutionService", "env_rpc_url", "map_intent", "serve"]
